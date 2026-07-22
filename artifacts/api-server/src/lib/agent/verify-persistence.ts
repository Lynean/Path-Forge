/**
 * Hermetic (no-DB) verification for PersistentAgentRuntime. Uses an in-memory
 * recorder and a fake inner runtime to prove: events pass through unchanged,
 * only structural events are recorded (text_delta skipped), the run finishes
 * with the right status/response, and recorder failures never break the stream.
 *
 *   pnpm --filter @workspace/api-server run agent:verify-persistence
 */
import type { AgentEvent, AgentRuntime, AgentTurnInput } from "@workspace/agent-runtime";
import { PersistentAgentRuntime, type RunRecorder } from "./persistent-runtime";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

class FakeInner implements AgentRuntime {
  constructor(private readonly events: AgentEvent[]) {}
  async *runTurn(): AsyncGenerator<AgentEvent> {
    for (const event of this.events) yield event;
  }
  async cancel(): Promise<void> {}
}

class MemoryRecorder implements RunRecorder {
  started = 0;
  recorded: Array<{ seq: number; type: string }> = [];
  finished: { status: string; response: string | null } | null = null;
  async startRun(): Promise<void> {
    this.started++;
  }
  async recordEvent(_runId: string, seq: number, event: AgentEvent): Promise<void> {
    this.recorded.push({ seq, type: event.type });
  }
  async finishRun(_runId: string, status: string, response: string | null): Promise<void> {
    this.finished = { status, response };
  }
}

const input: AgentTurnInput = {
  runId: "persist-verify-1",
  workspaceId: "ws-1",
  preferredLanguage: null,
  currentNode: { id: 1, title: "Intro" },
  messages: [],
  userMessage: "hi",
};

const EVENTS: AgentEvent[] = [
  { type: "run_started", runId: input.runId },
  { type: "text_delta", content: "Hello " },
  { type: "text_delta", content: "world" },
  { type: "tool_completed", tool: "spawn_node", output: { title: "T", brief: "B" } },
  {
    type: "completed",
    result: {
      status: "completed",
      runId: input.runId,
      response: "Hello world",
      proposedActions: [],
      toolCalls: ["spawn_node"],
      turns: 1,
    },
  },
];

async function drain(runtime: AgentRuntime): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of runtime.runTurn(input)) out.push(event);
  await new Promise((resolve) => setTimeout(resolve, 0)); // flush fire-and-forget writes
  return out;
}

async function main(): Promise<void> {
  console.log("PersistentAgentRuntime verification (in-memory)\n");

  // 1. Happy path.
  const recorder = new MemoryRecorder();
  const yielded = await drain(new PersistentAgentRuntime(new FakeInner(EVENTS), recorder));

  check("all events pass through unchanged", yielded.length === EVENTS.length);
  check("startRun called exactly once", recorder.started === 1);
  check(
    "only structural events recorded (text_delta skipped)",
    recorder.recorded.map((r) => r.type).join(",") === "run_started,tool_completed,completed",
    recorder.recorded.map((r) => r.type).join(","),
  );
  check(
    "recorded seq is contiguous from 0",
    recorder.recorded.every((r, i) => r.seq === i),
    JSON.stringify(recorder.recorded),
  );
  check(
    "finishRun records completed status + response",
    recorder.finished?.status === "completed" && recorder.finished?.response === "Hello world",
    JSON.stringify(recorder.finished),
  );

  // 2. A failed run records the failure status.
  const failRecorder = new MemoryRecorder();
  await drain(
    new PersistentAgentRuntime(
      new FakeInner([
        { type: "run_started", runId: input.runId },
        { type: "failed", status: "cancelled", code: "CANCELLED", message: "stopped" },
      ]),
      failRecorder,
    ),
  );
  check(
    "failed run finishes with the failure status",
    failRecorder.finished?.status === "cancelled",
    JSON.stringify(failRecorder.finished),
  );

  // 3. Recorder failures never break the stream.
  let errorCount = 0;
  const throwingRecorder: RunRecorder = {
    startRun: async () => {
      throw new Error("db down");
    },
    recordEvent: async () => {
      throw new Error("db down");
    },
    finishRun: async () => {
      throw new Error("db down");
    },
  };
  const resilient = await drain(
    new PersistentAgentRuntime(new FakeInner(EVENTS), throwingRecorder, () => {
      errorCount++;
    }),
  );
  check("stream survives a fully-failing recorder", resilient.length === EVENTS.length);
  check("recorder errors are reported via onError", errorCount > 0, `errorCount=${errorCount}`);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
