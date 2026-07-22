import type {
  AgentEvent,
  AgentResult,
  AgentRuntime,
  AgentTurnInput,
} from "@workspace/agent-runtime";
import type { ChatToolCall } from "../aiNodeChat";

// The concrete signature of the existing tutor-chat generator. Referenced as a
// type only (`typeof import(...)`) so this module has NO value import of
// aiNodeChat — keeping it free of the OpenRouter client and therefore runnable
// in a hermetic, no-network verification. Production wiring injects the real
// function via `LegacyAgentRuntimeDeps.streamChat`.
type StreamNodeChatMessage = typeof import("../aiNodeChat")["streamNodeChatMessage"];
type StreamChatParams = Parameters<StreamNodeChatMessage>;

/**
 * The request-scoped tutor-chat context that `streamNodeChatMessage` needs but
 * the narrow coding-agent {@link AgentTurnInput} does not carry (project,
 * profile, map graph, code files, …). It is loaded from Postgres by the caller
 * — mirroring how `agent-desktop` injects `context`/`tools` into `AgentHarness`
 * rather than deriving them from the turn input. Derived from the real
 * parameter list so it stays in lockstep with the generator's signature.
 */
export interface LegacyChatContext {
  node: StreamChatParams[0];
  project: StreamChatParams[1];
  profile: StreamChatParams[2];
  history: StreamChatParams[3];
  mapCtx: StreamChatParams[5];
  recentConcerns: StreamChatParams[6];
  codeFiles: StreamChatParams[7];
  completedStepIndices: NonNullable<StreamChatParams[8]>;
}

export interface LegacyAgentRuntimeDeps {
  /** Loads the tutor-chat context for a turn (typically DB reads in the route). */
  loadContext: (input: AgentTurnInput) => Promise<LegacyChatContext>;
  /** The tutor-chat generator, injected so tests can supply a fake. */
  streamChat: StreamNodeChatMessage;
}

/**
 * Maps the legacy tool calls onto the contract's coarse `proposedActions`
 * summary. This is intentionally lossy — the full call arguments (step numbers,
 * new steps, spawn titles) are preserved separately as `tool_completed` events,
 * because the DAG/DB mutations they drive live outside the runtime's trust
 * boundary and remain the caller's responsibility in this phase.
 */
function toProposedActions(toolCalls: ChatToolCall[]): AgentResult["proposedActions"] {
  if (toolCalls.length === 0) {
    return [{ type: "none", reason: "No plan changes proposed." }];
  }
  return toolCalls.map((call): AgentResult["proposedActions"][number] => {
    const reason = typeof call.args.reason === "string" && call.args.reason.trim()
      ? call.args.reason.trim()
      : call.name;
    switch (call.name) {
      case "regenerate_session":
        return { type: "revise_plan", reason };
      case "spawn_node":
        return { type: "spawn_node", reason };
      case "update_step":
      case "add_steps":
      case "mark_steps_done":
        return { type: "update_steps", reason };
      default:
        return { type: "none", reason };
    }
  });
}

/**
 * `AgentRuntime` adapter over the existing `aiNodeChat` tutor flow. It wraps the
 * text stream and returned tool calls into the typed `AgentEvent` protocol
 * without changing any behavior or touching the database. It is the fallback
 * runtime the API server selects by default; the OpenAI/sandbox runtime lands
 * in a later phase.
 */
export class LegacyAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly deps: LegacyAgentRuntimeDeps) {}

  async *runTurn(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    const controller = new AbortController();
    this.active.set(input.runId, controller);

    yield { type: "run_started", runId: input.runId };

    let fullContent = "";
    try {
      const ctx = await this.deps.loadContext(input);
      const gen = this.deps.streamChat(
        ctx.node,
        ctx.project,
        ctx.profile,
        ctx.history,
        input.userMessage,
        ctx.mapCtx,
        ctx.recentConcerns,
        ctx.codeFiles,
        ctx.completedStepIndices,
      );

      let step = await gen.next();
      while (!step.done) {
        if (controller.signal.aborted) {
          yield {
            type: "failed",
            status: "cancelled",
            code: "CANCELLED",
            message: "Run cancelled",
          };
          return;
        }
        fullContent += step.value;
        yield { type: "text_delta", content: step.value };
        step = await gen.next();
      }

      const toolCalls = step.value;
      // Preserve each call losslessly (name + full args) so a future DB-aware
      // consumer can drive the same mutations the route does today.
      for (const call of toolCalls) {
        yield { type: "tool_completed", tool: call.name, output: call.args };
      }

      const result: AgentResult = {
        status: "completed",
        runId: input.runId,
        response: fullContent,
        proposedActions: toProposedActions(toolCalls),
        toolCalls: toolCalls.map((call) => call.name),
        turns: 1,
      };
      yield { type: "completed", result };
    } catch (err) {
      yield {
        type: "failed",
        status: "failed",
        code: "HARNESS_ERROR",
        message: err instanceof Error ? err.message : "Stream error",
      };
    } finally {
      this.active.delete(input.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    this.active.get(runId)?.abort();
  }
}
