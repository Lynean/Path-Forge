import { z } from "zod/v4";
import type { CommandPolicy } from "../policy/command-policy";
import type { SandboxCommandRequest } from "../sandbox/agent-sandbox";
import type { SandboxManager } from "../sandbox/sandbox-manager";
import type { AgentTool, AgentToolContext, AgentToolStreamEvent } from "./tool";

export const runCommandInputSchema = z
  .object({
    command: z.string().min(1).max(100),
    arguments: z.array(z.string().max(200)).max(10),
    workingDirectory: z.string().min(1).max(500).default("."),
  })
  .strict();

export interface RunCommandToolOptions {
  policy: CommandPolicy;
  sandboxes: SandboxManager;
  description?: string;
  timeoutMs?: number;
  maxOutputCharacters?: number;
}

/** Keeps the command contract visible while returning an explicit unsupported-runtime result. */
export class UnsupportedRunCommandTool implements AgentTool {
  readonly name = "run_command";
  readonly inputSchema = runCommandInputSchema;
  readonly description: string;

  constructor(private readonly reason: string) {
    this.description = `Project command execution is unavailable: ${reason}`;
  }

  async execute(
    _arguments: Record<string, unknown>,
    _context?: AgentToolContext,
  ): Promise<unknown> {
    return {
      ok: false,
      error: "UNSUPPORTED_RUNTIME",
      reason: this.reason,
    };
  }

  async *executeStream(
    arguments_: Record<string, unknown>,
    context: AgentToolContext,
  ): AsyncIterable<AgentToolStreamEvent> {
    yield { type: "result", output: await this.execute(arguments_, context) };
  }
}

/** Validates intent through policy before delegating execution to an isolated sandbox. */
export class RunCommandTool implements AgentTool {
  readonly name = "run_command";
  readonly description: string;
  readonly inputSchema = runCommandInputSchema;

  constructor(private readonly options: RunCommandToolOptions) {
    this.description =
      options.description ??
      "Run an approved package test, typecheck, or build script in an isolated sandbox. Commands outside policy are returned as structured rejections.";
  }

  private requestFor(arguments_: Record<string, unknown>): SandboxCommandRequest {
    const input = runCommandInputSchema.parse(arguments_);
    return {
      command: input.command,
      arguments: input.arguments,
      workingDirectory: input.workingDirectory,
      timeoutMs: this.options.timeoutMs ?? 30_000,
      maxOutputCharacters: this.options.maxOutputCharacters ?? 50_000,
    };
  }

  private rejectedOutput(request: SandboxCommandRequest): unknown | null {
    const decision = this.options.policy.evaluate(request);
    return decision.allowed
      ? null
      : {
          ok: false,
          error: "POLICY_REJECTED",
          code: decision.code,
          reason: decision.reason,
        };
  }

  async execute(
    arguments_: Record<string, unknown>,
    context?: AgentToolContext,
  ): Promise<unknown> {
    if (!context) throw new Error("run_command requires an agent run context");
    const request = this.requestFor(arguments_);
    const decision = this.options.policy.evaluate(request);
    if (!decision.allowed) {
      return {
        ok: false,
        error: "POLICY_REJECTED",
        code: decision.code,
        reason: decision.reason,
      };
    }

    const result = await this.options.sandboxes.execute(
      context.runId,
      decision.request,
      { signal: context.signal },
    );
    return { ok: true, ...result };
  }

  async *executeStream(
    arguments_: Record<string, unknown>,
    context: AgentToolContext,
  ): AsyncIterable<AgentToolStreamEvent> {
    const request = this.requestFor(arguments_);
    const rejected = this.rejectedOutput(request);
    if (rejected) {
      yield { type: "result", output: rejected };
      return;
    }

    yield {
      type: "progress",
      stage: "sandbox_preparing",
      message: "Preparing a filtered project snapshot and isolated Docker session.",
    };
    const session = await this.options.sandboxes.prepareRun(context.runId, context.signal);
    const dependencyMessage =
      session.dependencyCache === "hit"
        ? "Locked dependencies were restored from the trusted cache."
        : session.dependencyCache === "miss"
          ? "Locked dependencies were installed and saved for future matching runs."
          : "No locked dependency installation was needed.";
    const runtimeMessage = session.runtime
      ? `${session.runtime.ecosystem} ${session.runtime.version}${session.runtime.dependencyManager ? ` with ${session.runtime.dependencyManager}` : ""} is ready.`
      : "The approved runtime is ready.";
    yield {
      type: "progress",
      stage: "sandbox_ready",
      message: `${runtimeMessage} ${dependencyMessage} Networking is disconnected and source is isolated.`,
    };
    yield {
      type: "progress",
      stage: "command_running",
      message: `Running ${request.command} ${request.arguments.join(" ")} inside Docker.`,
    };
    const result = await this.options.sandboxes.executePrepared(session, request, {
      signal: context.signal,
    });
    yield { type: "result", output: { ok: true, ...result } };
  }

  async finishRun(runId: string): Promise<void> {
    await this.options.sandboxes.disposeRun(runId);
  }
}
