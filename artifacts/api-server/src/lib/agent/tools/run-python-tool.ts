import { z } from "zod/v4";
import type { AgentTool, WorkspaceAccess } from "@workspace/agent-runtime";
import { runPythonInWasm } from "../../wasm/runPython";

/**
 * Runs Python in a WASM (Pyodide) sandbox — no Docker required — so the tutor can
 * catch real errors and show logs for common Python projects even when the
 * learner has no container runtime. Deny-by-default: no host filesystem, no
 * network, no display. Reads a project file (`path`) or runs an ad-hoc snippet
 * (`code`).
 */
export class RunPythonTool implements AgentTool {
  readonly name = "run_python";
  readonly description =
    "Run Python in a fast isolated WASM sandbox (no Docker needed) and get back stdout, stderr, and any traceback. Use it to check the learner's code for errors, run a script, or verify a snippet. Provide `path` to run a file from the project, or `code` to run a snippet. Pure Python + WASM-available packages only — no system commands, no network, and no display, so graphical/hardware code (pygame, tkinter) errors on the missing environment rather than a real bug; for those, reason from the code instead of running it.";
  readonly inputSchema = z
    .object({
      path: z.string().min(1).optional(),
      code: z.string().min(1).optional(),
    })
    .strict();

  constructor(private readonly workspace: WorkspaceAccess) {}

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    const { path, code } = this.inputSchema.parse(arguments_);
    let source: string;
    if (path) {
      source = await this.workspace.readTextFile(path);
    } else if (code) {
      source = code;
    } else {
      throw new Error("Provide either `path` (a project file) or `code` (a snippet) to run.");
    }

    const result = await runPythonInWasm(source, { timeoutMs: 30_000 });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
      timedOut: result.timedOut,
    };
  }
}
