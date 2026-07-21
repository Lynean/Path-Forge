import type {
  AgentSandbox,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxOperationContext,
  SandboxSession,
} from "./agent-sandbox";

/** Lazily creates and reuses one sandbox session for each active agent run. */
export class SandboxManager {
  private readonly sessions = new Map<string, Promise<SandboxSession>>();

  constructor(
    private readonly sandbox: AgentSandbox,
    private readonly workspaceRoot: string,
    private readonly workspaceEdits: () => Array<{ path: string; content: string }> = () => [],
  ) {}

  async prepareRun(runId: string, signal: AbortSignal): Promise<SandboxSession> {
    let pending = this.sessions.get(runId);
    if (!pending) {
      pending = this.sandbox.prepare({
        runId,
        workspaceRoot: this.workspaceRoot,
        workspaceEdits: this.workspaceEdits(),
        signal,
      });
      this.sessions.set(runId, pending);
    }

    try {
      return await pending;
    } catch (error) {
      if (this.sessions.get(runId) === pending) this.sessions.delete(runId);
      throw error;
    }
  }

  async execute(
    runId: string,
    request: SandboxCommandRequest,
    context: SandboxOperationContext,
  ): Promise<SandboxCommandResult> {
    const session = await this.prepareRun(runId, context.signal);
    return await this.executePrepared(session, request, context);
  }

  async executePrepared(
    session: SandboxSession,
    request: SandboxCommandRequest,
    context: SandboxOperationContext,
  ): Promise<SandboxCommandResult> {
    return await this.sandbox.execute(session, request, context);
  }

  async disposeRun(runId: string): Promise<void> {
    const pending = this.sessions.get(runId);
    if (!pending) return;
    this.sessions.delete(runId);
    const session = await pending;
    await this.sandbox.dispose(session);
  }

  async refreshRun(runId: string): Promise<void> {
    await this.disposeRun(runId);
  }
}
