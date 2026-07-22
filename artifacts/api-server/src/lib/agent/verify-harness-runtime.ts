/**
 * Hermetic (no-network) smoke test for the HarnessAgentRuntime. It injects the
 * lab's FakeTutorModelAdapter — so no OpenRouter call, no API key — and drives a
 * real turn through the actual AgentHarness, proving that workspace
 * materialization, harness wiring, the event stream, and temp cleanup all work.
 *
 *   pnpm --filter @workspace/api-server run agent:verify-harness
 */
import { FakeTutorModelAdapter, type AgentEvent } from "@workspace/agent-runtime";
import type { AgentTurnInput } from "@workspace/agent-runtime";
import { HarnessAgentRuntime } from "./harness-runtime";
import type { LegacyChatContext } from "./legacy-runtime";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
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
    codeFiles: [
      { filename: "src/index.ts", description: "entry", content: "console.log('hi');", changeLog: [] },
    ],
    completedStepIndices: [],
  }) as unknown as LegacyChatContext;

function input(runId: string): AgentTurnInput {
  return {
    runId,
    workspaceId: "ws-1",
    preferredLanguage: null,
    currentNode: { id: 1, title: "Intro" },
    messages: [],
    userMessage: "hi",
  };
}

async function runOnce(runId: string): Promise<AgentEvent[]> {
  const runtime = new HarnessAgentRuntime({
    loadContext,
    createModel: () => new FakeTutorModelAdapter(),
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn(input(runId))) events.push(event);
  return events;
}

async function main(): Promise<void> {
  console.log("HarnessAgentRuntime smoke test (fake model, no network)\n");

  const events = await runOnce("harness-verify-1");
  check("first event is run_started", events[0]?.type === "run_started");

  const completed = events.find((e) => e.type === "completed");
  check(
    "harness reaches completed with a non-empty response",
    completed?.type === "completed" && completed.result.response.trim().length > 0,
    JSON.stringify(events.map((e) => e.type)),
  );
  check("no failed event", !events.some((e) => e.type === "failed"));

  // A second run proves per-run temp-workspace setup + cleanup is repeatable.
  const second = await runOnce("harness-verify-2");
  check(
    "second run also completes (cleanup is repeatable)",
    second.some((e) => e.type === "completed") && !second.some((e) => e.type === "failed"),
    JSON.stringify(second.map((e) => e.type)),
  );

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
