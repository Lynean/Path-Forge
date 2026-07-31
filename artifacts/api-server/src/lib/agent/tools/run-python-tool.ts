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
  readonly maxCallsPerRun = 1;
  readonly description =
    "Run Python ONCE per tutor turn in a fast isolated WASM sandbox and get stdout, stderr, and the exact traceback. Use `path` for a real project file OR `code` for a snippet, never both. After an error, quote the exact traceback/error evidence in your answer instead of running Python again. Pure Python + WASM-available packages only — no system commands, network, or display.";
  readonly inputSchema = z
    .object({
      path: z.string().min(1).optional(),
      code: z.string().min(1).optional(),
    })
    .strict()
    .refine(
      ({ path, code }) => Boolean(path) !== Boolean(code),
      "Provide exactly one of path or code.",
    );

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
