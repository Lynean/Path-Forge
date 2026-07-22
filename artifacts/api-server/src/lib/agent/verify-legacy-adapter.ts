/**
 * Deterministic, no-network regression proof for the LegacyAgentRuntime + SSE
 * adapter. It injects a fake tutor-chat generator (so no OpenRouter call, no API
 * key, no DB) and asserts that driving the wrapped runtime and translating its
 * events reproduces exactly the SSE the current chat route emits for the same
 * stream, and that tool-call arguments survive losslessly.
 *
 *   pnpm --filter @workspace/api-server run agent:verify-adapter
 */
import type { AgentEvent, AgentTurnInput } from "@workspace/agent-runtime";
import type { ChatToolCall } from "../aiNodeChat";
import { LegacyAgentRuntime, type LegacyChatContext } from "./legacy-runtime";
import { agentEventToSse } from "./sse-adapter";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

const CHUNKS = ["Let's ", "wire up ", "the sandbox."];
const TOOL_CALLS: ChatToolCall[] = [
  { name: "mark_steps_done", args: { stepNumbers: [1, 2] } },
  { name: "spawn_node", args: { title: "Docker basics", brief: "Learn images vs containers" } },
];

// How the live route (nodeMap.ts) serializes the same stream, reproduced here as
// the oracle: one `chunk` per yielded delta, then a single trailing `done`.
function routeSse(chunks: string[], response: string): string[] {
  const out = chunks.map(
    (content) => `data: ${JSON.stringify({ type: "chunk", content })}\n\n`,
  );
  out.push(`data: ${JSON.stringify({ type: "done", content: response })}\n\n`);
  return out;
}

// The runtime ignores the context for a fake generator, so the injected
// streamChat's real parameter list is irrelevant here — cast to `any`.
function fakeStreamChat(chunks: string[], toolCalls: ChatToolCall[]): any {
  return async function* (): AsyncGenerator<string, ChatToolCall[], void> {
    for (const c of chunks) yield c;
    return toolCalls;
  };
}

const loadContext = async (): Promise<LegacyChatContext> =>
  ({}) as unknown as LegacyChatContext;

const input: AgentTurnInput = {
  runId: "run-verify-1",
  workspaceId: "ws-1",
  preferredLanguage: null,
  currentNode: { id: 1, title: "Intro" },
  messages: [],
  userMessage: "help me",
};

async function collect(runtime: LegacyAgentRuntime): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of runtime.runTurn(input)) events.push(e);
  return events;
}

async function main(): Promise<void> {
  console.log("LegacyAgentRuntime adapter verification\n");

  // 1. Happy path: SSE parity + lossless tool calls.
  const runtime = new LegacyAgentRuntime({
    loadContext,
    streamChat: fakeStreamChat(CHUNKS, TOOL_CALLS),
  });
  const events = await collect(runtime);

  const sseLines = events.map(agentEventToSse).filter((l): l is string => l !== null);
  const expected = routeSse(CHUNKS, CHUNKS.join(""));
  check(
    "SSE stream is byte-identical to the current route",
    JSON.stringify(sseLines) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(sseLines)}`,
  );

  check("first event is run_started", events[0]?.type === "run_started");
  check(
    "text_delta count matches chunks",
    events.filter((e) => e.type === "text_delta").length === CHUNKS.length,
  );

  const toolEvents = events.filter((e) => e.type === "tool_completed");
  check(
    "every tool call preserved as tool_completed with exact args",
    toolEvents.length === TOOL_CALLS.length &&
      toolEvents.every((e, i) => {
        const tc = e as Extract<AgentEvent, { type: "tool_completed" }>;
        return (
          tc.tool === TOOL_CALLS[i].name &&
          JSON.stringify(tc.output) === JSON.stringify(TOOL_CALLS[i].args)
        );
      }),
    JSON.stringify(toolEvents),
  );

  const completed = events.find((e) => e.type === "completed");
  check(
    "completed.result carries response + tool names + turns",
    completed?.type === "completed" &&
      completed.result.response === CHUNKS.join("") &&
      JSON.stringify(completed.result.toolCalls) ===
        JSON.stringify(TOOL_CALLS.map((t) => t.name)) &&
      completed.result.turns === 1,
  );

  // 2. Error path → single error SSE, no done.
  const errRuntime = new LegacyAgentRuntime({
    loadContext,
    streamChat: (() => {
      return async function* (): AsyncGenerator<string, ChatToolCall[], void> {
        throw new Error("AI response was cut off (length) before finishing — please try again.");
      };
    })() as any,
  });
  const errEvents = await collect(errRuntime);
  const errSse = errEvents.map(agentEventToSse).filter((l): l is string => l !== null);
  check(
    "error path emits exactly one error SSE event",
    errSse.length === 1 &&
      errSse[0].includes('"type":"error"') &&
      errSse[0].includes("cut off"),
    JSON.stringify(errSse),
  );

  // 3. Cancellation → failed(cancelled) once aborted mid-stream.
  const cancelRuntime = new LegacyAgentRuntime({
    loadContext,
    streamChat: (() => {
      return async function* (): AsyncGenerator<string, ChatToolCall[], void> {
        yield "partial";
        // A real generator would keep going; the runtime checks the abort flag
        // before pulling the next delta.
        yield "more";
        return [];
      };
    })() as any,
  });
  const cancelEvents: AgentEvent[] = [];
  for await (const e of cancelRuntime.runTurn(input)) {
    cancelEvents.push(e);
    if (e.type === "text_delta") await cancelRuntime.cancel(input.runId);
  }
  const lastCancel = cancelEvents[cancelEvents.length - 1];
  check(
    "cancel mid-stream ends with failed(cancelled)",
    lastCancel?.type === "failed" &&
      lastCancel.status === "cancelled" &&
      lastCancel.code === "CANCELLED",
    JSON.stringify(cancelEvents.map((e) => e.type)),
  );

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
