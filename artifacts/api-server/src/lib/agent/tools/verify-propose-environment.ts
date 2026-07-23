/**
 * Verifies the propose_environment tool: validates + echoes a Docker environment
 * proposal, and surfaces through the harness as a tool_completed event (the shape
 * the chat records + shows). Hermetic (fake model, no network/Docker).
 *
 *   pnpm --filter @workspace/api-server run agent:verify-propose-environment
 */
import type {
  AgentDecision,
  AgentEvent,
  AgentTurnInput,
  ModelAdapter,
  ModelTurnContext,
} from "@workspace/agent-runtime";
import { HarnessAgentRuntime } from "../harness-runtime";
import type { LegacyChatContext } from "../legacy-runtime";
import { ProposeEnvironmentTool } from "./propose-environment-tool";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

class ProposeThenFinishModel implements ModelAdapter {
  private called = false;
  async decide(_context: ModelTurnContext): Promise<AgentDecision> {
    if (!this.called) {
      this.called = true;
      return {
        type: "tool_call",
        call: {
          id: "c1",
          name: "propose_environment",
          arguments: {
            language: "rust",
            baseImage: "rust:1.83-slim",
            setupCommands: ["cargo build"],
            runCommand: "cargo test",
            reason: "This is a Cargo project; the Node/Python sandboxes can't build it.",
          },
        },
      };
    }
    return { type: "final", response: "Proposed a Rust environment.", proposedActions: [{ type: "none", reason: "done" }] };
  }
}

async function main(): Promise<void> {
  console.log("propose_environment verification\n");

  // Direct: valid proposal echoes; invalid (no baseImage) rejected.
  const tool = new ProposeEnvironmentTool();
  const echoed = (await tool.execute({ language: "go", baseImage: "golang:1.23", reason: "Go module" })) as {
    proposedEnvironment?: { baseImage?: string };
    recorded?: boolean;
  };
  check("echoes a validated proposal", echoed.recorded === true && echoed.proposedEnvironment?.baseImage === "golang:1.23", JSON.stringify(echoed));

  let rejected = false;
  try {
    await tool.execute({ language: "go" }); // missing baseImage + reason
  } catch {
    rejected = true;
  }
  check("rejects an incomplete proposal", rejected);

  // End-to-end through the harness.
  const loadContext = async (): Promise<LegacyChatContext> =>
    ({
      node: { id: 1, title: "Intro", brief: "" },
      project: { title: "Demo", ideaPrompt: "A Rust CLI" },
      profile: null, history: [], mapCtx: { allNodes: [], allEdges: [] },
      recentConcerns: [], codeFiles: [], completedStepIndices: [],
    }) as unknown as LegacyChatContext;
  const runtime = new HarnessAgentRuntime({ loadContext, createModel: () => new ProposeThenFinishModel() });
  const input: AgentTurnInput = {
    runId: "propenv-1", workspaceId: "w", preferredLanguage: null,
    currentNode: { id: 1, title: "Intro" }, messages: [], userMessage: "how do I run this Rust project?",
  };
  const events: AgentEvent[] = [];
  for await (const e of runtime.runTurn(input)) events.push(e);

  const proposal = events.find(
    (e): e is Extract<AgentEvent, { type: "tool_completed" }> =>
      e.type === "tool_completed" && e.tool === "propose_environment",
  );
  check(
    "harness surfaces propose_environment with the proposal",
    !!proposal && (proposal.output as { proposedEnvironment?: { baseImage?: string } }).proposedEnvironment?.baseImage === "rust:1.83-slim",
    JSON.stringify(proposal?.output),
  );
  check("turn completes", events.some((e) => e.type === "completed"));

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
