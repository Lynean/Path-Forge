/**
 * Deterministic verification for bounded exact workspace evidence.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run agent:verify-relevant-code
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReadFileTool,
  WorkspaceAccess,
  type AgentDecision,
  type ModelAdapter,
  type ModelTurnContext,
} from "@workspace/agent-runtime";
import { streamAgenticStepDetail } from "./agent/harness-runtime";
import {
  RELEVANT_CODE_LIMITS,
  buildRelevantCodeContext,
  formatRelevantCodeContext,
  readRelevantCodeContext,
  type RelevantCodeSource,
} from "./relevantCodeContext";

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const python = `from datetime import datetime
from typing import List

class CompletionRecord:
    def __init__(self, timestamp: datetime):
        self.timestamp = timestamp
`;
const pythonContext = buildRelevantCodeContext(
  [{ path: "models.py", content: python }],
  "CompletionRecord timestamp constructor",
);
const pythonEvidence = formatRelevantCodeContext(pythonContext);
check(
  "exact Python constructor is preserved verbatim",
  pythonEvidence.includes("def __init__(self, timestamp: datetime):"),
);
check(
  "retrieval does not invent the stale dataclass version",
  !pythonEvidence.includes("@dataclass") && !pythonEvidence.includes("note: str"),
);

const manySources: RelevantCodeSource[] = Array.from({ length: 1_000 }, (_, index) => ({
  path: `src/components/Component${index}.tsx`,
  content: Array.from(
    { length: 250 },
    (__, line) => `export const value${index}_${line} = ${line};`,
  ).join("\n"),
}));
manySources.push({
  path: "src/components/HabitPanel.tsx",
  content: Array.from(
    { length: 300 },
    (_, line) =>
      line === 220
        ? "export function HabitPanel() { return <section>Habits</section>; }"
        : `const padding${line} = ${line};`,
  ).join("\n"),
});
const largeContext = buildRelevantCodeContext(
  manySources,
  "Update the HabitPanel React component",
);
check(
  "large source sets retain at most three files",
  largeContext.excerpts.length <= RELEVANT_CODE_LIMITS.maxFiles,
);
check(
  "large source sets retain at most 160 lines",
  largeContext.totalLines <= RELEVANT_CODE_LIMITS.maxTotalLines,
);
check(
  "large source sets retain at most 12,000 characters",
  largeContext.totalCharacters <= RELEVANT_CODE_LIMITS.maxTotalCharacters,
);
check(
  "ranking finds a relevant component deep inside a large file",
  largeContext.excerpts.some(
    (excerpt) =>
      excerpt.path === "src/components/HabitPanel.tsx" &&
      excerpt.content.includes("function HabitPanel"),
  ),
);

const fixture = await mkdtemp(join(tmpdir(), "pathforge-relevant-code-"));
try {
  await mkdir(join(fixture, "src", "components"), { recursive: true });
  await writeFile(join(fixture, "models.py"), python, "utf8");
  await writeFile(
    join(fixture, "src", "components", "HabitPanel.tsx"),
    [
      "const before = true;",
      "export function HabitPanel() {",
      "  return <div>Current workspace</div>;",
      "}",
      "const after = true;",
    ].join("\n"),
    "utf8",
  );
  const targeted = await readRelevantCodeContext(
    fixture,
    "Change src/components/HabitPanel.tsx next.",
    "HabitPanel current workspace",
  );
  check(
    "an explicit React path is re-read exactly without workspace dumping",
    targeted.excerpts.length === 1 &&
      targeted.excerpts[0]?.content.includes("Current workspace"),
  );
  const reader = new ReadFileTool(new WorkspaceAccess(fixture), 20_000);
  const ranged = await reader.execute({
    path: "src/components/HabitPanel.tsx",
    startLine: 2,
    endLine: 4,
  }) as { content: string; startLine: number; endLine: number };
  check(
    "read_file can return an exact bounded line range",
    ranged.startLine === 2 &&
      ranged.endLine === 4 &&
      ranged.content.startsWith("export function HabitPanel") &&
      !ranged.content.includes("const before") &&
      !ranged.content.includes("const after"),
  );
  const limitedReader = new ReadFileTool(new WorkspaceAccess(fixture), 20_000, 1);
  await limitedReader.execute({ path: "src/components/HabitPanel.tsx" });
  const blockedRead = await limitedReader.execute({
    path: "src/components/HabitPanel.tsx",
    startLine: 2,
    endLine: 4,
  }) as { error?: string };
  check(
    "inspection file-read count is enforced by the tool",
    blockedRead.error === "READ_FILE_LIMIT_REACHED",
  );

  class ScriptedStepGeneratorModel implements ModelAdapter {
    sawGraphTool = false;
    sawGraphPolicy = false;

    async decide(context: ModelTurnContext): Promise<AgentDecision> {
      this.sawGraphTool ||= context.tools.some((tool) => tool.name === "graph_search");
      this.sawGraphPolicy ||= context.documents.soul.includes(
        "You are the step generator. You own both evidence retrieval",
      );
      const graphResult = context.observations.find(
        (observation) => observation.tool === "graph_search",
      );
      if (!graphResult) {
        return {
          type: "tool_call",
          call: {
            id: "find-completion-record",
            name: "graph_search",
            arguments: { query: "CompletionRecord", maxResults: 3 },
          },
        };
      }
      const evidence = JSON.stringify(graphResult.output);
      return {
        type: "final",
        response: evidence.includes("def __init__(self, timestamp: datetime):")
          ? "## What you'll build\n\nContinue from the current `CompletionRecord.__init__` constructor."
          : "The required current constructor was not found.",
        proposedActions: [{ type: "none", reason: "Read-only retrieval is complete." }],
      };
    }
  }

  const scriptedModel = new ScriptedStepGeneratorModel();
  const agentEvents = [];
  for await (const event of streamAgenticStepDetail({
    node: {
      id: 1,
      mapId: 1,
      title: "Track completion history",
      brief: "Extend the current model.",
      status: "available",
      isExtra: false,
      summary: null,
      agentContext: "Use models.py and CompletionRecord.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      positionX: null,
      positionY: null,
    },
    project: { title: "Habit tracker", ideaPrompt: "Build a Python habit tracker." },
    profile: null,
    mapCtx: { allNodes: [], allEdges: [] },
    codeFiles: [],
    workspaceRoot: fixture,
    step: {
      index: 2,
      title: "Use CompletionRecord",
      brief: "Build on the existing CompletionRecord constructor.",
    },
    model: scriptedModel,
  })) {
    agentEvents.push(event);
  }
  const completed = agentEvents.find((event) => event.type === "completed");
  check(
    "the step generator itself receives graph tools and the graph-first policy",
    scriptedModel.sawGraphTool && scriptedModel.sawGraphPolicy,
  );
  check(
    "one agent searches current code and then writes the grounded step",
    agentEvents.some(
      (event) => event.type === "tool_completed" && event.tool === "graph_search",
    ) &&
      completed?.type === "completed" &&
      completed.result.response.includes("CompletionRecord.__init__") &&
      !completed.result.response.includes("@dataclass"),
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}

if (failures > 0) process.exitCode = 1;
