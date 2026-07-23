/**
 * Verifies the run_python harness tool: runs a real project file and an ad-hoc
 * snippet through the WASM sandbox, and surfaces a Python error. Boots Pyodide a
 * few times (slow). No Docker, no network.
 *
 *   pnpm --filter @workspace/api-server run agent:verify-run-python-tool
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceAccess } from "@workspace/agent-runtime";
import { RunPythonTool } from "./run-python-tool";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("run_python tool verification\n");

  const dir = await mkdtemp(join(tmpdir(), "runpy-"));
  await writeFile(join(dir, "hello.py"), "print('from the project file')\n", "utf8");
  const tool = new RunPythonTool(new WorkspaceAccess(dir));

  const fromFile = (await tool.execute({ path: "hello.py" })) as { stdout: string; error: string | null };
  check("runs a project file and captures its stdout", fromFile.stdout.includes("from the project file") && fromFile.error === null, JSON.stringify(fromFile));

  const fromSnippet = (await tool.execute({ code: "print(6 * 7)" })) as { stdout: string };
  check("runs an ad-hoc code snippet", fromSnippet.stdout.includes("42"), JSON.stringify(fromSnippet));

  const withError = (await tool.execute({ code: "raise ValueError('boom')" })) as { error: string | null };
  check("surfaces a Python error to the tutor", (withError.error ?? "").includes("ValueError") && (withError.error ?? "").includes("boom"), JSON.stringify(withError));

  await rm(dir, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
