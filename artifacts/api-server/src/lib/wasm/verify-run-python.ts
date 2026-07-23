/**
 * Verifies the WASM Python execution engine: captures stdout, surfaces real
 * tracebacks, and terminates a runaway loop via the hard timeout. No Docker,
 * no network. Slow (each run boots a fresh Pyodide) — allow a minute.
 *
 *   pnpm --filter @workspace/api-server run agent:verify-run-python
 */
import { runPythonInWasm } from "./runPython";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("WASM Python (Pyodide) execution verification\n");

  const ok = await runPythonInWasm("print('hello wasm'); print(2 + 2)");
  check("captures stdout", ok.stdout.includes("hello wasm") && ok.stdout.includes("4"), JSON.stringify(ok));
  check("clean run has no error", ok.error === null && !ok.timedOut);

  const err = await runPythonInWasm("x = 1 / 0");
  check(
    "surfaces the real traceback (ZeroDivisionError)",
    (err.error ?? "").includes("ZeroDivisionError"),
    JSON.stringify(err),
  );

  const loop = await runPythonInWasm("while True:\n    pass", { timeoutMs: 15_000 });
  check("terminates a runaway loop via timeout", loop.timedOut === true, JSON.stringify(loop));

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
