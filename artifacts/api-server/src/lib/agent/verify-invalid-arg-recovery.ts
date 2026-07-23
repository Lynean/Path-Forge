/**
 * Verifies invalid tool arguments are recoverable (bounded): a model that first
 * calls inspect_project with a bad `path` key gets the validation error fed back
 * as an observation, then self-corrects with valid args and the run completes —
 * instead of the whole turn failing. No network (fake model), no Docker (empty
 * temp folder → command tool degrades).
 *
 *   pnpm --filter @workspace/api-server run agent:verify-invalid-arg-recovery
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentDecision,
  AgentEvent,
  AgentTurnInput,
  ModelAdapter,
  ModelTurnContext,
} from "@workspace/agent-runtime";
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

// Calls inspect_project with a spurious `path` (invalid) first; once it sees the
// rejection observation, retries with valid args; then finalizes.
class RecoveringModel implements ModelAdapter {
  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    const succeeded = context.observations.some(
      (o) => o.tool === "inspect_project" && !(o.output as { error?: unknown })?.error,
    );
    if (succeeded) {
      return { type: "final", response: "Inspected the project after fixing my arguments.", proposedActions: [{ type: "none", reason: "done" }] };
    }
    const wasRejected = context.observations.some(
      (o) => (o.output as { error?: unknown })?.error === "INVALID_TOOL_ARGUMENTS",
    );
    return wasRejected
      ? { type: "tool_call", call: { id: "good", name: "inspect_project", arguments: {} } }
      : { type: "tool_call", call: { id: "bad", name: "inspect_project", arguments: { path: "src" } } };
  }
}

async function main(): Promise<void> {
  console.log("Invalid tool-argument recovery verification\n");

  const dir = await mkdtemp(join(tmpdir(), "recover-"));
  const loadContext = async (): Promise<LegacyChatContext> =>
    ({
      node: { id: 1, title: "Intro", brief: "" },
      project: { title: "Demo", ideaPrompt: "x" },
      profile: null, history: [], mapCtx: { allNodes: [], allEdges: [] },
      recentConcerns: [], codeFiles: [], completedStepIndices: [],
      workspaceRoot: dir,
    }) as unknown as LegacyChatContext;

  const runtime = new HarnessAgentRuntime({ loadContext, createModel: () => new RecoveringModel() });
  const input: AgentTurnInput = {
    runId: "recover-1", workspaceId: "w", preferredLanguage: null,
    currentNode: { id: 1, title: "Intro" }, messages: [], userMessage: "inspect the project",
  };

  const events: AgentEvent[] = [];
  for await (const e of runtime.runTurn(input)) events.push(e);
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  check("bad arguments were rejected (not fatal)", events.some((e) => e.type === "tool_rejected" && e.code === "INVALID_TOOL_ARGUMENTS"), JSON.stringify(events.map((e) => e.type)));
  check("model recovered: inspect_project then ran successfully", events.some((e) => e.type === "tool_completed" && e.tool === "inspect_project"));
  check("run completed (did not fail)", events.some((e) => e.type === "completed") && !events.some((e) => e.type === "failed"));

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
