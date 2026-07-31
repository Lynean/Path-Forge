/**
 * Hermetic (no-network) verification for the PathForge plan-proposal tools and
 * their end-to-end surfacing through the harness. Injects a fake model that
 * calls `spawn_node`, then asserts the harness emits a `tool_completed` event
 * carrying the proposal — the shape the chat route turns into a DB mutation.
 *
 *   pnpm --filter @workspace/api-server run agent:verify-domain-tools
 */
import type {
  AgentDecision,
  AgentEvent,
  AgentTurnInput,
  ModelAdapter,
  ModelTurnContext,
} from "@workspace/agent-runtime";
import { HarnessAgentRuntime, isPlanCorrectionRequest } from "./harness-runtime";
import type { LegacyChatContext } from "./legacy-runtime";
import { createPathforgePlanTools } from "./tools/plan-proposal-tools";
import { extractStepCodeCells, type ChatMessage } from "../aiNodeChat";
import { sanitizeUserMemoryMarkdown } from "../userMemory";
import {
  groundTutorResponseInToolEvidence,
  isCrossStepCorrectionReason,
} from "./response-guards";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Calls spawn_node on the first decision, then finalizes. */
class SpawnNodeThenFinishModel implements ModelAdapter {
  private called = false;
  async decide(_context: ModelTurnContext): Promise<AgentDecision> {
    if (!this.called) {
      this.called = true;
      return {
        type: "tool_call",
        call: {
          id: "call-1",
          name: "spawn_node",
          arguments: { title: "Docker basics", brief: "Learn images vs containers" },
        },
      };
    }
    return {
      type: "final",
      response: "I proposed a new node for Docker basics.",
      proposedActions: [{ type: "none", reason: "handled via tool" }],
    };
  }
}

class CorrectionOnlyModel implements ModelAdapter {
  observedTools: string[] = [];
  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    this.observedTools = context.tools.map((tool) => tool.name).sort();
    const unavailableFileToolWasRejected = context.observations.some(
      (observation) =>
        observation.tool === "read_file" &&
        (observation.output as { error?: unknown })?.error === "UNKNOWN_TOOL",
    );
    if (!unavailableFileToolWasRejected) {
      return {
        type: "tool_call",
        call: {
          id: "wrong-correction-tool",
          name: "read_file",
          arguments: { path: "habit_tracker.py" },
        },
      };
    }
    if (context.observations.some((observation) => observation.tool === "regenerate_session")) {
      return {
        type: "final",
        response: "I corrected the lesson plan.",
        proposedActions: [{ type: "none", reason: "done" }],
      };
    }
    return {
      type: "tool_call",
      call: {
        id: "correct-session",
        name: "regenerate_session",
        arguments: {
          reason: "Use habit_tracker.py consistently in every sibling step.",
        },
      },
    };
  }
}

const loadContext = async (): Promise<LegacyChatContext> =>
  ({
    node: { id: 1, title: "Intro", brief: "" },
    project: { title: "Demo", ideaPrompt: "Build a todo app" },
    profile: null,
    history: [],
    mapCtx: { allNodes: [], allEdges: [] },
    recentConcerns: [],
    codeFiles: [],
    completedStepIndices: [],
  }) as unknown as LegacyChatContext;

const input: AgentTurnInput = {
  runId: "domain-verify-1",
  workspaceId: "ws-1",
  preferredLanguage: null,
  currentNode: { id: 1, title: "Intro" },
  messages: [],
  userMessage: "Can you add a separate lesson on Docker?",
};

async function main(): Promise<void> {
  console.log("PathForge plan-proposal tools verification\n");

  // 1. Direct tool validation.
  const tools = createPathforgePlanTools();
  check(
    "all six plan tools are registered",
    tools.map((t) => t.name).sort().join(",") ===
      [
        "add_steps",
        "mark_steps_done",
        "regenerate_session",
        "regenerate_step_with_notes",
        "spawn_node",
        "update_step_description",
      ].join(","),
    tools.map((t) => t.name).join(","),
  );

  const spawn = tools.find((t) => t.name === "spawn_node")!;
  const echoed = (await spawn.execute({ title: "T", brief: "B" })) as Record<string, unknown>;
  check(
    "spawn_node echoes a validated proposal",
    echoed.title === "T" && echoed.brief === "B" && echoed.recorded === true,
    JSON.stringify(echoed),
  );

  let rejected = false;
  try {
    await spawn.execute({ title: "T" }); // missing brief
  } catch {
    rejected = true;
  }
  check("spawn_node rejects invalid arguments", rejected);

  const update = tools.find((t) => t.name === "update_step_description")!;
  let updateRejected = false;
  try {
    await update.execute({ stepNumber: 2 }); // missing reason
  } catch {
    updateRejected = true;
  }
  check("update_step_description rejects missing reason", updateRejected);

  const regenerateStep = tools.find((t) => t.name === "regenerate_step_with_notes")!;
  let regenerateRejected = false;
  try {
    await regenerateStep.execute({ stepNumber: 3 }); // missing issueNote
  } catch {
    regenerateRejected = true;
  }
  check("regenerate_step_with_notes rejects missing issueNote", regenerateRejected);
  const correction = (await regenerateStep.execute({
    stepNumber: 3,
    issueNote: "Keep add_completion from step 2.",
  })) as Record<string, unknown>;
  check(
    "regenerate_step_with_notes preserves a validated issue note",
    correction.stepNumber === 3 &&
      correction.issueNote === "Keep add_completion from step 2." &&
      correction.recorded === true,
  );

  // 2. A later step receives only code from earlier step pages. This reproduces
  // the reported regression: step 3 must see add_completion from step 2, but
  // must not feed a stale/broken step-3 page back into its own regeneration.
  const history: ChatMessage[] = [
    {
      role: "assistant",
      content:
        "[STEP_DETAIL:2]\n```python\n@dataclass\nclass Habit:\n    completions: list[CompletionRecord]\n\n    def add_completion(self, note: str = \"\"):\n        self.completions.append(CompletionRecord(datetime.now(), note))\n```\n[/STEP_DETAIL:2]",
      createdAt: new Date().toISOString(),
    },
    {
      role: "assistant",
      content:
        "[STEP_DETAIL:3]\n```python\n@dataclass\nclass Habit:\n    def streak(self) -> int:\n        return 0\n```\n[/STEP_DETAIL:3]",
      createdAt: new Date().toISOString(),
    },
  ];
  const priorCode = extractStepCodeCells(history, 3);
  check(
    "step 3 receives cumulative code from step 2",
    priorCode.includes("add_completion") && priorCode.includes("completions"),
    priorCode,
  );
  check(
    "step 3 regeneration excludes its own stale code",
    !priorCode.includes("def streak"),
    priorCode,
  );

  // 3. End-to-end: proposal surfaces as a tool_completed event.
  const runtime = new HarnessAgentRuntime({
    loadContext,
    createModel: () => new SpawnNodeThenFinishModel(),
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn(input)) events.push(event);

  const spawnEvent = events.find(
    (e): e is Extract<AgentEvent, { type: "tool_completed" }> =>
      e.type === "tool_completed" && e.tool === "spawn_node",
  );
  check(
    "harness surfaces spawn_node as tool_completed with the proposal",
    !!spawnEvent &&
      (spawnEvent.output as Record<string, unknown>).title === "Docker basics" &&
      (spawnEvent.output as Record<string, unknown>).brief === "Learn images vs containers",
    JSON.stringify(spawnEvent?.output),
  );
  check("turn still reaches completed", events.some((e) => e.type === "completed"));

  // 4. A plan-correction turn has no unrelated filesystem/run tools available.
  check(
    "filename feedback is classified as a plan correction",
    isPlanCorrectionRequest(
      "Step 2 uses the wrong filename; update all steps to habit_tracker.py.",
    ),
  );
  check(
    "CLI step context does not misclassify a code crash as plan correction",
    !isPlanCorrectionRequest(
      `[Context: I'm on step 3 — "Load JSON"]\n` +
        "My code crashes. Please run habits.py, quote the traceback, and explain the smallest fix.",
    ),
  );
  const correctionModel = new CorrectionOnlyModel();
  const correctionRuntime = new HarnessAgentRuntime({
    loadContext,
    createModel: () => correctionModel,
  });
  const correctionEvents: AgentEvent[] = [];
  for await (const event of correctionRuntime.runTurn({
    ...input,
    runId: "domain-correction-1",
    userMessage:
      "Step 2 uses the wrong filename; update all steps to habit_tracker.py.",
  })) {
    correctionEvents.push(event);
  }
  check(
    "correction mode exposes only correction tools",
    correctionModel.observedTools.join(",") ===
      [
        "regenerate_session",
        "regenerate_step_with_notes",
        "update_step_description",
      ].join(","),
    correctionModel.observedTools.join(","),
  );
  check(
    "an unrelated file-tool call is rejected without terminating correction",
    correctionEvents.some(
      (event) =>
        event.type === "tool_rejected" &&
        event.tool === "read_file" &&
        event.code === "UNKNOWN_TOOL",
    ),
    JSON.stringify(correctionEvents),
  );
  check(
    "cross-step correction completes through regenerate_session",
    correctionEvents.some(
      (event) =>
        event.type === "tool_completed" &&
        event.tool === "regenerate_session",
    ) && correctionEvents.some((event) => event.type === "completed"),
    JSON.stringify(correctionEvents),
  );
  check(
    "filename correction is marked for sibling-step propagation",
    isCrossStepCorrectionReason("Replace the filename with habit_tracker.py in all steps."),
  );

  const traceback =
    'Traceback (most recent call last):\n  File "habit_tracker.py", line 9\nNameError: missing_name';
  const groundedAnswer = groundTutorResponseInToolEvidence(
    "Your program crashed because a name is missing.",
    [{ name: "run_python", args: { error: traceback } }],
  );
  check(
    "tutor output includes the exact traceback evidence",
    groundedAnswer.includes(traceback) &&
      groundedAnswer.includes("habit_tracker.py") &&
      groundedAnswer.includes("line 9"),
    groundedAnswer,
  );

  const cleanUserMemory = sanitizeUserMemoryMarkdown(
    [
      "# Learner",
      "- Age: 12",
      "- Likes short explanations",
      "## Current project",
      "- HabitTracker uses habit_tracker.py",
      "- Uses dataclasses and a command-line menu",
      "- Preferred language: Python",
    ].join("\n"),
    {
      projectTitle: "HabitTracker",
      nodeTitle: "Store habit completions",
      profileSummary: "Age: 12. Likes short explanations.",
    },
  );
  check(
    "USER.md keeps durable learner facts but removes project-specific state",
    cleanUserMemory.includes("Age: 12") &&
      cleanUserMemory.includes("short explanations") &&
      !cleanUserMemory.includes("HabitTracker") &&
      !cleanUserMemory.includes("habit_tracker.py") &&
      !cleanUserMemory.includes("dataclasses") &&
      !cleanUserMemory.includes("Preferred language: Python"),
    cleanUserMemory,
  );

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
