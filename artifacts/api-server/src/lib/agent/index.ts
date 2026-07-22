import type { AgentRuntime } from "@workspace/agent-runtime";
import { streamNodeChatMessage } from "../aiNodeChat";
import { LegacyAgentRuntime, type LegacyAgentRuntimeDeps } from "./legacy-runtime";
import { HarnessAgentRuntime } from "./harness-runtime";

export * from "./legacy-runtime";
export * from "./harness-runtime";
export * from "./sse-adapter";

export type AgentRuntimeKind = "legacy" | "harness";

/**
 * Resolves which runtime to use from `AGENT_RUNTIME`. Defaults to `legacy` so
 * behavior is unchanged unless explicitly opted in with `AGENT_RUNTIME=harness`.
 */
export function resolveAgentRuntimeKind(
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeKind {
  return env.AGENT_RUNTIME === "harness" ? "harness" : "legacy";
}

/**
 * Composition point for the API server. The caller supplies `loadContext`
 * (the request-scoped DB reads); both runtimes consume it — the legacy one to
 * build its tutor prompt, the harness one to seed a disposable code workspace.
 */
export function createAgentRuntime(
  deps: Pick<LegacyAgentRuntimeDeps, "loadContext">,
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntime {
  if (resolveAgentRuntimeKind(env) === "harness") {
    return new HarnessAgentRuntime(deps);
  }
  return new LegacyAgentRuntime({ ...deps, streamChat: streamNodeChatMessage });
}
