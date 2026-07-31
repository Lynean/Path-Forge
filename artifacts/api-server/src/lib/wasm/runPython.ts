import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export interface RunPythonResult {
  stdout: string;
  stderr: string;
  /** Python traceback / error message, or null on clean completion. */
  error: string | null;
  timedOut: boolean;
}

export interface RunPythonOptions {
  /** Wall-clock budget covering Pyodide load + execution. */
  timeoutMs?: number;
}

// The worker runs in a fresh Pyodide (WASM) sandbox per call — deny-by-default:
// no host filesystem, no network. A runaway loop is killed by terminating the
// worker on timeout. Passed as an eval string to avoid bundling/worker-path
// issues; `pyodide` is resolved from node_modules at runtime (esbuild-external).
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
parentPort.once("message", async ({ code, modulePath, indexURL }) => {
  let stdout = "";
  let stderr = "";
  try {
    // Point Pyodide at its own package dir so it finds pyodide.asm.wasm and the
    // python stdlib bundle. Resolve the package from THIS source module in the
    // parent: an eval worker launched from a monorepo root cannot see a
    // workspace package's private node_modules through bare-specifier lookup.
    const { loadPyodide } = await import(pathToFileURL(modulePath).href);
    const pyodide = await loadPyodide({ indexURL });
    pyodide.setStdout({ batched: (s) => { stdout += s + "\\n"; } });
    pyodide.setStderr({ batched: (s) => { stderr += s + "\\n"; } });
    let error = null;
    try {
      await pyodide.runPythonAsync(code);
    } catch (e) {
      error = String((e && e.message) || e);
    }
    parentPort.postMessage({ stdout, stderr, error });
  } catch (e) {
    parentPort.postMessage({ stdout, stderr, error: "WASM Python runtime failed to start: " + String((e && e.message) || e) });
  }
});
`;

const requireFromThisModule = createRequire(import.meta.url);
const PYODIDE_MODULE_PATH = requireFromThisModule.resolve("pyodide/pyodide.mjs");
const PYODIDE_INDEX_URL = dirname(PYODIDE_MODULE_PATH);

/**
 * Runs Python code in an isolated WASM (Pyodide) sandbox in a worker thread,
 * capturing stdout/stderr and any traceback. Guarantees termination via a hard
 * timeout. No Docker required. This is the Tier-1 execution the tutor uses to
 * catch real errors and show logs for common Python projects.
 */
export function runPythonInWasm(
  code: string,
  options: RunPythonOptions = {},
): Promise<RunPythonResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise<RunPythonResult>((resolve) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    let settled = false;

    const finish = (result: RunPythonResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ stdout: "", stderr: "", error: `Execution timed out after ${timeoutMs}ms.`, timedOut: true });
    }, timeoutMs);

    worker.on("message", (msg: { stdout: string; stderr: string; error: string | null }) => {
      finish({ stdout: msg.stdout, stderr: msg.stderr, error: msg.error, timedOut: false });
    });
    worker.on("error", (err: Error) => {
      finish({ stdout: "", stderr: "", error: String(err?.message ?? err), timedOut: false });
    });

    worker.postMessage({
      code,
      modulePath: PYODIDE_MODULE_PATH,
      indexURL: PYODIDE_INDEX_URL,
    });
  });
}
