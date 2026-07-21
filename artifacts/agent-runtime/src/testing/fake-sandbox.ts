import type {
  AgentSandbox,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxOperationContext,
  SandboxPrepareRequest,
  SandboxSession,
} from "../sandbox/agent-sandbox";

export interface FakeSandboxOptions {
  files?: Record<string, string>;
  commandResults?: Record<string, Omit<SandboxCommandResult, "command" | "arguments">>;
  commandDelayMs?: number;
}

function commandKey(request: Pick<SandboxCommandRequest, "command" | "arguments">): string {
  return JSON.stringify([request.command, ...request.arguments]);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Sandbox operation cancelled");
}

async function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Sandbox operation cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Deterministic sandbox used to test harness integrations without executing host commands. */
export class FakeSandbox implements AgentSandbox {
  readonly preparedSessions: SandboxSession[] = [];
  readonly prepareRequests: SandboxPrepareRequest[] = [];
  readonly commandRequests: SandboxCommandRequest[] = [];
  readonly disposedSessionIds: string[] = [];
  private readonly activeSessionIds = new Set<string>();

  constructor(private readonly options: FakeSandboxOptions = {}) {}

  static commandKey(command: string, arguments_: string[] = []): string {
    return commandKey({ command, arguments: arguments_ });
  }

  async prepare(request: SandboxPrepareRequest): Promise<SandboxSession> {
    assertNotAborted(request.signal);
    this.prepareRequests.push(request);
    const session = {
      id: `fake-sandbox-${this.preparedSessions.length + 1}`,
      runId: request.runId,
      workspaceRoot: request.workspaceRoot,
      dependencyCache: "not_used" as const,
    };
    this.preparedSessions.push(session);
    this.activeSessionIds.add(session.id);
    return session;
  }

  async execute(
    session: SandboxSession,
    request: SandboxCommandRequest,
    context: SandboxOperationContext,
  ): Promise<SandboxCommandResult> {
    this.assertActive(session);
    assertNotAborted(context.signal);
    this.commandRequests.push(request);
    await waitForDelay(this.options.commandDelayMs ?? 0, context.signal);
    const configured = this.options.commandResults?.[commandKey(request)];
    if (!configured) {
      throw new Error(`Fake sandbox has no result for ${request.command}`);
    }
    return { command: request.command, arguments: [...request.arguments], ...configured };
  }

  async readFile(
    session: SandboxSession,
    path: string,
    context: SandboxOperationContext,
  ): Promise<string> {
    this.assertActive(session);
    assertNotAborted(context.signal);
    const content = this.options.files?.[path];
    if (content === undefined) throw new Error(`Fake sandbox file not found: ${path}`);
    return content;
  }

  async dispose(session: SandboxSession): Promise<void> {
    this.assertActive(session);
    this.activeSessionIds.delete(session.id);
    this.disposedSessionIds.push(session.id);
  }

  private assertActive(session: SandboxSession): void {
    if (!this.activeSessionIds.has(session.id)) {
      throw new Error(`Fake sandbox session is not active: ${session.id}`);
    }
  }
}
