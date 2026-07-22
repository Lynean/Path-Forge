import type { AgentRuntime } from "@workspace/agent-runtime";
import { streamNodeChatMessage } from "../aiNodeChat";
import { LegacyAgentRuntime, type LegacyAgentRuntimeDeps } from "./legacy-runtime";
import { HarnessAgentRuntime } from "./harness-runtime";
import { PersistentAgentRuntime, type RunRecorder } from "./persistent-runtime";

export * from "./legacy-runtime";
export * from "./harness-runtime";
export * from "./persistent-runtime";
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

export interface CreateAgentRuntimeDeps extends Pick<LegacyAgentRuntimeDeps, "loadContext"> {
  /** When provided, the runtime is wrapped to durably record the run + events. */
  recorder?: RunRecorder;
  /** Reports (swallowed) recording failures without breaking the chat stream. */
  onRecorderError?: (error: unknown, stage: string) => void;
}

/**
 * Composition point for the API server. The caller supplies `loadContext`
 * (the request-scoped DB reads); both runtimes consume it — the legacy one to
 * build its tutor prompt, the harness one to seed a disposable code workspace.
 * An optional `recorder` wraps the result to persist the run for audit/telemetry.
 */
export function createAgentRuntime(
  deps: CreateAgentRuntimeDeps,
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntime {
  const { recorder, onRecorderError, ...runtimeDeps } = deps;
  const inner: AgentRuntime =
    resolveAgentRuntimeKind(env) === "harness"
      ? new HarnessAgentRuntime(runtimeDeps)
      : new LegacyAgentRuntime({ ...runtimeDeps, streamChat: streamNodeChatMessage });
  return recorder ? new PersistentAgentRuntime(inner, recorder, onRecorderError) : inner;
}
