import { z } from "zod/v4";
import type { AgentTool } from "@workspace/agent-runtime";
import { buildAndRunCustomEnvironment, type CustomEnvironmentSpec } from "../customEnvironment";

export interface ApprovedEnvironment {
  baseImage: string;
  setupCommands: string[];
  runCommand: string;
  dockerfile?: string | null;
}

/**
 * Runs a command in the learner's APPROVED custom Docker environment: builds the
 * content-addressed image (may use the network) then runs in a locked sandbox
 * (no network, dropped caps, resource limits). Only added to the harness when
 * the learner has approved an environment for the project.
 */
export class RunInEnvironmentTool implements AgentTool {
  readonly name = "run_in_environment";
  readonly description =
    "Run a shell command in the learner's approved custom Docker environment and get back stdout/stderr/exit code. Use this to build, test, or run projects the Node/Python sandboxes can't (Go, Rust, Java, C/C++, …). Omit `command` to run the approved default command. The first build can take a while; the run is sandboxed with no network.";
  readonly inputSchema = z
    .object({ command: z.string().min(1).optional() })
    .strict() as unknown as z.ZodType<Record<string, unknown>>;

  constructor(
    private readonly environment: ApprovedEnvironment,
    private readonly workspaceRoot: string,
  ) {}

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    const { command } = z.object({ command: z.string().min(1).optional() }).parse(arguments_);
    const spec: CustomEnvironmentSpec = {
      baseImage: this.environment.baseImage,
      setupCommands: this.environment.setupCommands,
      runCommand: command ?? this.environment.runCommand,
      ...(this.environment.dockerfile ? { dockerfile: this.environment.dockerfile } : {}),
    };
    const result = await buildAndRunCustomEnvironment(spec, this.workspaceRoot, {
      buildTimeoutMs: 300_000,
      runTimeoutMs: 120_000,
    });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 12_000),
      stderr: result.stderr.slice(-4_000),
      error: result.error,
      timedOut: result.timedOut,
    };
  }
}
