/**
 * Deterministic replay of the failures found during the real-model HabitTracker
 * journey. It uses scripted model decisions and production guard functions, so
 * it needs neither OpenRouter nor Docker.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run agent:eval-habittracker
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentHarness,
  GraphSearchTool,
  ProjectGraphStore,
  ToolRegistry,
  WorkspaceAccess,
  type AgentDecision,
  type AgentEvent,
  type AgentTool,
  type AgentTurnInput,
  type ModelAdapter,
  type ModelTurnContext,
} from "@workspace/agent-runtime";
import { z } from "zod/v4";
import { extractStepCodeCells, type ChatMessage } from "../../aiNodeChat";
import { sanitizeUserMemoryMarkdown } from "../../userMemory";
import { HarnessAgentRuntime, isPlanCorrectionRequest } from "../harness-runtime";
import type { LegacyChatContext } from "../legacy-runtime";
import {
  applySessionWideCorrectionInvariant,
  buildCompletionProjectDocument,
  buildEffectiveStepNote,
  parseOpeningSlides,
  parseStepSlideBody,
} from "../learning-plan-guards";
import {
  groundTutorResponseInToolEvidence,
  usesStepCorrectionTool,
} from "../response-guards";

interface ReplayEvidence {
  summary: string;
  values: Record<string, unknown>;
}

interface HabitTrackerReplayCase {
  id: string;
  finding: string;
  learnerPrompt: string;
  replay: () => Promise<ReplayEvidence>;
  grade: (evidence: ReplayEvidence) => string[];
}

const baseInput: AgentTurnInput = {
  runId: "habittracker-replay",
  workspaceId: "habittracker-fixture",
  preferredLanguage: "English",
  currentNode: { id: 4, title: "Date Logic", brief: "Handle completion dates" },
  messages: [],
  userMessage: "Help me with this step.",
};

function hasEvent(
  events: AgentEvent[],
  predicate: (event: AgentEvent) => boolean,
): boolean {
  return events.some(predicate);
}

class CorrectionReplayModel implements ModelAdapter {
  observedTools: string[] = [];

  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    this.observedTools = context.tools.map((tool) => tool.name).sort();
    const fileToolRejected = context.observations.some(
      (observation) =>
        observation.tool === "read_file" &&
        (observation.output as { error?: unknown })?.error === "UNKNOWN_TOOL",
    );
    if (!fileToolRejected) {
      return {
        type: "tool_call",
        call: {
          id: "unrelated-file-read",
          name: "read_file",
          arguments: { path: "schema_draft.py" },
        },
      };
    }
    if (context.observations.some((item) => item.tool === "regenerate_session")) {
      return {
        type: "final",
        response: "I corrected the whole lesson plan.",
        proposedActions: [{ type: "none", reason: "correction recorded" }],
      };
    }
    return {
      type: "tool_call",
      call: {
        id: "session-correction",
        name: "regenerate_session",
        arguments: {
          reason: "Use habits.py consistently in this step and every sibling step.",
        },
      },
    };
  }
}

class InvalidArgumentsRecoveryModel implements ModelAdapter {
  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    const completed = context.observations.some(
      (item) =>
        item.tool === "inspect_project" &&
        !(item.output as { error?: unknown })?.error,
    );
    if (completed) {
      return {
        type: "final",
        response: "I recovered and inspected the project.",
        proposedActions: [{ type: "none", reason: "done" }],
      };
    }
    const rejected = context.observations.some(
      (item) =>
        (item.output as { error?: unknown })?.error === "INVALID_TOOL_ARGUMENTS",
    );
    return rejected
      ? {
          type: "tool_call",
          call: { id: "valid-inspection", name: "inspect_project", arguments: {} },
        }
      : {
          type: "tool_call",
          call: {
            id: "invalid-inspection",
            name: "inspect_project",
            arguments: { path: "src" },
          },
        };
  }
}

class OneShotPythonTool implements AgentTool {
  readonly name = "run_python";
  readonly description = "Run one Python file once.";
  readonly inputSchema = z.object({ path: z.string().min(1) }).strict();
  readonly maxCallsPerRun = 1;
  executions = 0;

  async execute(): Promise<unknown> {
    this.executions += 1;
    return {
      ok: false,
      error:
        'Traceback (most recent call last):\n  File "<exec>", line 36, in <module>\nKeyError: \'missing\'',
    };
  }
}

class PythonCapReplayModel implements ModelAdapter {
  toolAvailabilityByTurn: string[][] = [];

  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    this.toolAvailabilityByTurn.push(context.tools.map((tool) => tool.name));
    const pythonEvidence = context.observations.find(
      (item) => item.tool === "run_python",
    );
    if (!pythonEvidence) {
      return {
        type: "tool_call",
        call: {
          id: "first-python-run",
          name: "run_python",
          arguments: { path: "habits.py" },
        },
      };
    }
    if (context.tools.some((tool) => tool.name === "run_python")) {
      return {
        type: "tool_call",
        call: {
          id: "unwanted-second-run",
          name: "run_python",
          arguments: { path: "habits.py" },
        },
      };
    }
    return {
      type: "final",
      response: "The exact traceback shows KeyError: 'missing' on line 36.",
      proposedActions: [{ type: "none", reason: "answered from existing evidence" }],
    };
  }
}

function contextFor(workspaceRoot: string): () => Promise<LegacyChatContext> {
  return async () =>
    ({
      node: { id: 4, title: "Date Logic", brief: "Handle completion dates" },
      project: { title: "HabitTracker", ideaPrompt: "Build python habits.py" },
      profile: null,
      history: [],
      mapCtx: { allNodes: [], allEdges: [] },
      recentConcerns: [],
      codeFiles: [],
      completedStepIndices: [],
      workspaceRoot,
    }) as unknown as LegacyChatContext;
}

const replayCases: HabitTrackerReplayCase[] = [
  {
    id: "correction-tool-isolation",
    finding: "Plan corrections called unrelated file tools and failed.",
    learnerPrompt:
      "Use habits.py consistently in this step and every sibling step. Do not inspect or edit files.",
    replay: async () => {
      const workspace = await mkdtemp(join(tmpdir(), "habittracker-correction-"));
      try {
        const model = new CorrectionReplayModel();
        const runtime = new HarnessAgentRuntime({
          loadContext: contextFor(workspace),
          createModel: () => model,
        });
        const events: AgentEvent[] = [];
        for await (const event of runtime.runTurn({
          ...baseInput,
          runId: "habittracker-correction",
          userMessage:
            "I'm 12 and this is confusing: this step uses schema_draft.py, but the project brief requires python habits.py. Please correct the lesson plan so habits.py is used consistently in this step and every sibling step. Do not inspect or edit files during this plan correction.",
        })) {
          events.push(event);
        }
        return {
          summary: "Replayed a wrong file-tool attempt followed by whole-session correction.",
          values: {
            tools: model.observedTools,
            rejectedUnrelatedTool: hasEvent(
              events,
              (event) =>
                event.type === "tool_rejected" &&
                event.tool === "read_file" &&
                event.code === "UNKNOWN_TOOL",
            ),
            regenerated: hasEvent(
              events,
              (event) =>
                event.type === "tool_completed" &&
                event.tool === "regenerate_session",
            ),
            completed: hasEvent(events, (event) => event.type === "completed"),
          },
        };
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    grade: ({ values }) => {
      const problems: string[] = [];
      const expectedTools = [
        "regenerate_session",
        "regenerate_step_with_notes",
        "update_step_description",
      ];
      if (JSON.stringify(values.tools) !== JSON.stringify(expectedTools)) {
        problems.push(`correction tool surface was ${JSON.stringify(values.tools)}`);
      }
      if (!values.rejectedUnrelatedTool) problems.push("unrelated read_file was not safely rejected");
      if (!values.regenerated) problems.push("regenerate_session did not complete");
      if (!values.completed) problems.push("the tutor turn did not complete");
      return problems;
    },
  },
  {
    id: "invalid-tool-arguments-recover",
    finding: "Invalid tool arguments terminated the CLI.",
    learnerPrompt: "Inspect my project.",
    replay: async () => {
      const workspace = await mkdtemp(join(tmpdir(), "habittracker-invalid-args-"));
      try {
        await writeFile(join(workspace, "habits.py"), "print('ok')\n", "utf8");
        const runtime = new HarnessAgentRuntime({
          loadContext: contextFor(workspace),
          createModel: () => new InvalidArgumentsRecoveryModel(),
        });
        const events: AgentEvent[] = [];
        for await (const event of runtime.runTurn({
          ...baseInput,
          runId: "habittracker-invalid-args",
          userMessage: "Inspect my project.",
        })) {
          events.push(event);
        }
        return {
          summary: "Replayed invalid inspect_project arguments and a corrected retry.",
          values: {
            rejected: hasEvent(
              events,
              (event) =>
                event.type === "tool_rejected" &&
                event.code === "INVALID_TOOL_ARGUMENTS",
            ),
            inspected: hasEvent(
              events,
              (event) =>
                event.type === "tool_completed" &&
                event.tool === "inspect_project",
            ),
            completed: hasEvent(events, (event) => event.type === "completed"),
            failed: hasEvent(events, (event) => event.type === "failed"),
          },
        };
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    grade: ({ values }) => [
      ...(!values.rejected ? ["invalid arguments were not surfaced as a recoverable rejection"] : []),
      ...(!values.inspected ? ["corrected inspect_project call did not execute"] : []),
      ...(!values.completed || values.failed ? ["run did not finish cleanly"] : []),
    ],
  },
  {
    id: "filename-propagates-to-siblings",
    finding: "A filename correction did not propagate to sibling lazy steps.",
    learnerPrompt: "Use habits.py in every sibling step.",
    replay: async () => {
      const opening = [
        "[SLIDE:intro]\nBuild the habit tracker.",
        "[SLIDE:1]\n**Schema**\nDefine the data shape.",
        "[SLIDE:2]\n**Storage**\nSave the data.\n[NOTE: DONE: schema exists]",
        "[SLIDE:3]\n**CLI**\nAdd commands.",
      ].join("\n\n");
      const corrected = applySessionWideCorrectionInvariant(
        opening,
        "Use habits.py consistently in every sibling step.",
      );
      const slides = parseOpeningSlides(corrected);
      const notes = slides
        .filter((slide) => slide.key !== "intro")
        .map((slide) => parseStepSlideBody(slide.body).note ?? "");
      return {
        summary: "Applied the production session-wide invariant to three lazy steps.",
        values: { stepCount: notes.length, notes, introChanged: slides[0]?.body !== "Build the habit tracker." },
      };
    },
    grade: ({ values }) => {
      const notes = values.notes as string[];
      return [
        ...(values.stepCount !== 3 ? ["not all sibling steps survived regeneration"] : []),
        ...(!notes.every((note) => note.includes("SESSION-WIDE INVARIANT") && note.includes("habits.py"))
          ? ["the filename invariant was missing from one or more lazy-step notes"]
          : []),
        ...(values.introChanged ? ["the correction helper unexpectedly rewrote the intro"] : []),
      ];
    },
  },
  {
    id: "prior-step-code-preserved",
    finding: "A later step removed code taught in an earlier step.",
    learnerPrompt: "Step 3 must keep add_completion from step 2.",
    replay: async () => {
      const history: ChatMessage[] = [
        {
          role: "assistant",
          content:
            "[STEP_DETAIL:2]\n```python\nclass Habit:\n    def add_completion(self):\n        self.completions.append('today')\n```\n[/STEP_DETAIL:2]",
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content:
            "[STEP_DETAIL:3]\n```python\nclass Habit:\n    def calculate_streak(self):\n        return 0\n```\n[/STEP_DETAIL:3]",
          createdAt: new Date().toISOString(),
        },
      ];
      const priorCode = extractStepCodeCells(history, 3);
      return {
        summary: "Rebuilt step 3's handoff from earlier pages only.",
        values: {
          containsEarlierFunction: priorCode.includes("add_completion"),
          containsStaleCurrentStep: priorCode.includes("calculate_streak"),
        },
      };
    },
    grade: ({ values }) => [
      ...(!values.containsEarlierFunction ? ["earlier add_completion code was lost"] : []),
      ...(values.containsStaleCurrentStep ? ["stale current-step code fed itself into regeneration"] : []),
    ],
  },
  {
    id: "future-work-is-out-of-scope",
    finding: "Several steps implemented a future node's work early.",
    learnerPrompt: "Keep Date Logic separate from the later list and streak work.",
    replay: async () => {
      const note = buildEffectiveStepNote({
        stepNote: "DONE: get_today_str exists. NEXT: verify date differences only.",
        laterSteps: [{ stepNumber: 4, title: "Date verification", brief: "Test date helpers" }],
        futureNodes: [
          { title: "Logic Core", brief: "Implement add, done, and list" },
          { title: "Streak Engine", brief: "Calculate consecutive days" },
        ],
      });
      return { summary: "Constructed the exact handoff supplied to the step writer.", values: { note } };
    },
    grade: ({ values }) => {
      const note = String(values.note);
      return [
        ...(!note.includes("AUTHORITATIVE LATER-STEP BOUNDARIES") ? ["later-step boundary missing"] : []),
        ...(!note.includes("AUTHORITATIVE FUTURE-NODE BOUNDARIES") ? ["future-node boundary missing"] : []),
        ...(!note.includes("Logic Core") || !note.includes("Streak Engine") ? ["future work was not named explicitly"] : []),
      ];
    },
  },
  {
    id: "python-runs-once",
    finding: "run_python ran three times for one crash.",
    learnerPrompt: "Run habits.py exactly once and explain the crash.",
    replay: async () => {
      const tool = new OneShotPythonTool();
      const model = new PythonCapReplayModel();
      const harness = new AgentHarness({
        model,
        tools: new ToolRegistry([tool]),
        maxTurns: 4,
      });
      const events: AgentEvent[] = [];
      for await (const event of harness.runTurn({
        ...baseInput,
        runId: "habittracker-python-cap",
        userMessage: "Run habits.py exactly once, quote the traceback, and explain the smallest fix.",
      })) {
        events.push(event);
      }
      return {
        summary: "Replayed a model that would request a second run if the capped tool stayed visible.",
        values: {
          executions: tool.executions,
          availableAfterRun: model.toolAvailabilityByTurn[1]?.includes("run_python") ?? true,
          completed: hasEvent(events, (event) => event.type === "completed"),
          turns: model.toolAvailabilityByTurn.length,
        },
      };
    },
    grade: ({ values }) => [
      ...(values.executions !== 1 ? [`run_python executed ${values.executions} times`] : []),
      ...(values.availableAfterRun ? ["run_python remained available after reaching its cap"] : []),
      ...(!values.completed ? ["model did not converge to a final answer"] : []),
      ...(Number(values.turns) > 2 ? ["the simple crash needed more than two model turns"] : []),
    ],
  },
  {
    id: "exact-traceback-is-grounded",
    finding: "The tutor did not quote the real traceback.",
    learnerPrompt: "Quote the exact traceback and line.",
    replay: async () => {
      const traceback =
        'Traceback (most recent call last):\n  File "<exec>", line 36, in <module>\nKeyError: \'missing\'';
      const answer = groundTutorResponseInToolEvidence(
        "A dictionary key is missing.",
        [{ name: "run_python", args: { error: traceback } }],
      );
      return { summary: "Grounded a vague tutor answer in captured execution evidence.", values: { answer, traceback } };
    },
    grade: ({ values }) => {
      const answer = String(values.answer);
      return [
        ...(!answer.includes(String(values.traceback)) ? ["exact traceback was omitted"] : []),
        ...(!answer.includes("line 36") ? ["real failing line was omitted"] : []),
        ...(!answer.includes("KeyError: 'missing'") ? ["real exception was omitted"] : []),
      ];
    },
  },
  {
    id: "project-memory-refreshes-after-completion",
    finding: "PROJECT.md became stale after later code changes.",
    learnerPrompt: "/done",
    replay: async () => {
      const snapshot = [
        "File tree (5 entries):",
        "- habits.py",
        "- habits.json",
        "- test_date_logic.py",
        "- test_streak_engine.py",
        "- PROJECT.md",
      ].join("\n");
      const document = buildCompletionProjectDocument({
        nodeTitle: "Integration",
        inspectionReport:
          "The HabitTracker CLI is complete. Both date and streak tests pass.",
        completionSummary: "Integrated add, done, list, persistence, and streaks.",
        workspaceSnapshot: snapshot,
      });
      return { summary: "Built completion-phase PROJECT.md from achieved state and current files.", values: { document } };
    },
    grade: ({ values }) => {
      const document = String(values.document);
      return [
        ...(!document.includes('refreshed after completing "Integration"') ? ["completion marker missing"] : []),
        ...(!document.includes("CLI is complete") ? ["achieved state missing"] : []),
        ...(!document.includes("test_date_logic.py") || !document.includes("test_streak_engine.py")
          ? ["current test files missing from memory"]
          : []),
        ...(!document.includes("Bounded workspace snapshot") ? ["deterministic workspace evidence missing"] : []),
      ];
    },
  },
  {
    id: "user-memory-stays-project-agnostic",
    finding: "USER.md contained project-specific information.",
    learnerPrompt: "I'm 12 and short explanations help me.",
    replay: async () => {
      const memory = sanitizeUserMemoryMarkdown(
        [
          "# User",
          "- Age: 12",
          "- Likes short explanations",
          "## Current project",
          "- HabitTracker uses habits.py",
          "- Uses Python dataclasses",
          "- Preferred language: Python",
        ].join("\n"),
        {
          projectTitle: "HabitTracker",
          nodeTitle: "Data Schema",
          profileSummary: "Age: 12. Likes short explanations.",
        },
      );
      return { summary: "Sanitized a mixed learner/project memory document.", values: { memory } };
    },
    grade: ({ values }) => {
      const memory = String(values.memory);
      return [
        ...(!memory.includes("Age: 12") || !memory.includes("short explanations") ? ["durable learner facts were lost"] : []),
        ...(/HabitTracker|habits\.py|dataclasses|Preferred language: Python/i.test(memory)
          ? ["project-specific content leaked into USER.md"]
          : []),
      ];
    },
  },
  {
    id: "one-file-graph-search-finishes",
    finding: "Graph search timed out on a one-file project.",
    learnerPrompt: "Find calculate_streak without reading the whole project.",
    replay: async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "habittracker-graph-"));
      try {
        await writeFile(
          join(workspaceRoot, "habits.py"),
          "def calculate_streak(completions):\n    return len(completions)\n",
          "utf8",
        );
        const workspace = new WorkspaceAccess(workspaceRoot);
        const tool = new GraphSearchTool(
          workspace,
          new ProjectGraphStore(workspace),
        );
        const startedAt = performance.now();
        const result = (await Promise.race([
          tool.execute({ query: "calculate_streak", maxResults: 3 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("graph search exceeded five seconds")), 5_000),
          ),
        ])) as {
          matches: Array<{ path: string; NodeCode: string }>;
          searchedFiles: number;
        };
        return {
          summary: "Built and searched the protected graph for a one-file Python project.",
          values: {
            durationMs: Math.round(performance.now() - startedAt),
            searchedFiles: result.searchedFiles,
            found: result.matches.some(
              (match) =>
                match.path === "habits.py" &&
                match.NodeCode.includes("calculate_streak"),
            ),
          },
        };
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    },
    grade: ({ values }) => [
      ...(values.searchedFiles !== 1 ? [`expected one searched file, got ${values.searchedFiles}`] : []),
      ...(!values.found ? ["calculate_streak was not retrieved"] : []),
      ...(Number(values.durationMs) >= 5_000 ? ["graph search exceeded its replay budget"] : []),
    ],
  },
  {
    id: "cli-context-does-not-hide-debug-tools",
    finding: "Injected CLI step context misclassified a crash as plan correction.",
    learnerPrompt: "My code crashes; run it and show me the traceback.",
    replay: async () => {
      const message =
        `[Context: I'm on step 3 — "Load JSON"]\n` +
        "My code crashes. Please run habits.py and explain the smallest fix.";
      return {
        summary: "Classified the exact transport-prefixed crash request.",
        values: { classifiedAsCorrection: isPlanCorrectionRequest(message) },
      };
    },
    grade: ({ values }) =>
      values.classifiedAsCorrection
        ? ["debug request was incorrectly put into correction-only mode"]
        : [],
  },
  {
    id: "all-correction-tools-use-concise-response",
    finding: "A whole-session correction repeated the entire lesson in chat.",
    learnerPrompt: "Correct the session plan without repeating the lesson.",
    replay: async () => {
      const toolNames = [
        "update_step_description",
        "regenerate_step_with_notes",
        "regenerate_session",
      ];
      return {
        summary: "Checked the response guard for every correction tool.",
        values: {
          guarded: toolNames.map((name) =>
            usesStepCorrectionTool([{ name, args: {} }]),
          ),
        },
      };
    },
    grade: ({ values }) =>
      (values.guarded as boolean[]).every(Boolean)
        ? []
        : ["one or more correction tools bypassed concise response synthesis"],
  },
];

async function main(): Promise<void> {
  console.log("HabitTracker harness replay\n");
  console.log(`Replaying ${replayCases.length} recorded guarantees without network or Docker.\n`);
  let failures = 0;
  const startedAt = performance.now();

  for (const scenario of replayCases) {
    try {
      const evidence = await scenario.replay();
      const problems = scenario.grade(evidence);
      if (problems.length === 0) {
        console.log(`PASS ${scenario.id}`);
        console.log(`     ${evidence.summary}`);
      } else {
        failures += 1;
        console.error(`FAIL ${scenario.id} — ${scenario.finding}`);
        for (const problem of problems) console.error(`     - ${problem}`);
      }
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${scenario.id} — replay crashed`);
      console.error(`     ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);
  console.log(
    `\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — ${replayCases.length - failures}/${replayCases.length} scenarios passed in ${durationMs}ms`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
