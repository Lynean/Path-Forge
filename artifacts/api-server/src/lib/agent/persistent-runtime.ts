import type { AgentEvent, AgentRuntime, AgentTurnInput } from "@workspace/agent-runtime";

/**
 * Sink for durable run recording. Implementations persist somewhere (Postgres in
 * production); the decorator below stays storage-agnostic and testable.
 */
export interface RunRecorder {
  startRun(input: AgentTurnInput): Promise<void>;
  recordEvent(runId: string, seq: number, event: AgentEvent): Promise<void>;
  finishRun(runId: string, status: string, response: string | null): Promise<void>;
}

// Token-level deltas and sandbox progress are high-volume/low-signal — the final
// text is stored on the run row, so we persist only the structural events.
const PERSISTED_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "run_started",
  "model_turn_started",
  "tool_started",
  "tool_completed",
  "tool_rejected",
  "completed",
  "failed",
]);

/**
 * Wraps any `AgentRuntime` and records the run + its structural events to a
 * `RunRecorder`, passing every event through unchanged. Recording is best-effort:
 * a recorder failure is reported and swallowed, never breaking the chat stream,
 * and event writes are fire-and-forget so they add no streaming latency.
 */
export class PersistentAgentRuntime implements AgentRuntime {
  constructor(
    private readonly inner: AgentRuntime,
    private readonly recorder: RunRecorder,
    private readonly onError: (error: unknown, stage: string) => void = () => {},
  ) {}

  async *runTurn(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    await this.safe(() => this.recorder.startRun(input), "startRun");
    let seq = 0;
    let status = "interrupted";
    let response: string | null = null;
    try {
      for await (const event of this.inner.runTurn(input)) {
        if (PERSISTED_EVENT_TYPES.has(event.type)) {
          const currentSeq = seq++;
          void this.safe(
            () => this.recorder.recordEvent(input.runId, currentSeq, event),
            "recordEvent",
          );
        }
        if (event.type === "completed") {
          status = "completed";
          response = event.result.response;
        } else if (event.type === "failed") {
          status = event.status;
        }
        yield event;
      }
    } finally {
      await this.safe(() => this.recorder.finishRun(input.runId, status, response), "finishRun");
    }
  }

  cancel(runId: string): Promise<void> {
    return this.inner.cancel(runId);
  }

  private async safe(fn: () => Promise<void>, stage: string): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.onError(error, stage);
    }
  }
}
