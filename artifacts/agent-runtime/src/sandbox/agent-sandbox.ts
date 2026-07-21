export interface SandboxPrepareRequest {
  runId: string;
  workspaceRoot: string;
  workspaceEdits?: Array<{ path: string; content: string }>;
  signal: AbortSignal;
}

export interface SandboxSession {
  id: string;
  runId: string;
  workspaceRoot: string;
  runtime?: {
    ecosystem: string;
    version: string;
    dependencyManager: string | null;
  };
  dependencyCache?: "not_used" | "hit" | "miss";
  dependencyCacheImage?: string;
}

export interface SandboxCommandRequest {
  command: string;
  arguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  timeoutMs: number;
  maxOutputCharacters: number;
}

export interface SandboxCommandResult {
  command: string;
  arguments: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface SandboxOperationContext {
  signal: AbortSignal;
}

/** A runtime-neutral boundary. Docker, a VM, or a test double can implement it. */
export interface AgentSandbox {
  prepare(request: SandboxPrepareRequest): Promise<SandboxSession>;
  execute(
    session: SandboxSession,
    request: SandboxCommandRequest,
    context: SandboxOperationContext,
  ): Promise<SandboxCommandResult>;
  readFile(
    session: SandboxSession,
    path: string,
    context: SandboxOperationContext,
  ): Promise<string>;
  dispose(session: SandboxSession): Promise<void>;
}
