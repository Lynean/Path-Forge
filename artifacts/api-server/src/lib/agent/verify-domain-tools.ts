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
import { HarnessAgentRuntime } from "./harness-runtime";
import type { LegacyChatContext } from "./legacy-runtime";
import { createPathforgePlanTools } from "./tools/plan-proposal-tools";

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
    "all five plan tools are registered",
    tools.map((t) => t.name).sort().join(",") ===
      ["add_steps", "mark_steps_done", "regenerate_session", "spawn_node", "update_step"].join(","),
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

  const update = tools.find((t) => t.name === "update_step")!;
  let updateRejected = false;
  try {
    await update.execute({ stepNumber: 2 }); // missing reason
  } catch {
    updateRejected = true;
  }
  check("update_step rejects missing reason", updateRejected);

  // 2. End-to-end: proposal surfaces as a tool_completed event.
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

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
