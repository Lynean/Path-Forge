import type { AgentEvent } from "@workspace/agent-runtime";

/**
 * Translates a typed {@link AgentEvent} into the exact SSE line the existing
 * chat endpoint already emits, so the frontend needs no changes:
 *
 *   text_delta  → { type: "chunk", content }   (route: nodeMap.ts chat loop)
 *   completed   → { type: "done",  content }
 *   failed      → { type: "error", error }
 *
 * Returns `null` for events with no chat-SSE equivalent (`run_started`,
 * `tool_completed`, `tool_*`). Those either carry no user-facing text or map to
 * database side effects (`step_done`, `plan_updated`, `extra_node_spawned`) that
 * stay the route's responsibility in this phase — the adapter deliberately does
 * not manufacture them, since the runtime performs no DB writes.
 */
export function agentEventToSse(event: AgentEvent): string | null {
  switch (event.type) {
    case "text_delta":
      return sse({ type: "chunk", content: event.content });
    case "completed":
      return sse({ type: "done", content: event.result.response });
    case "failed":
      return sse({ type: "error", error: event.message });
    default:
      return null;
  }
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
