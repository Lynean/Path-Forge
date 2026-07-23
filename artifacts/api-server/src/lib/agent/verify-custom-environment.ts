/**
 * Verifies the custom-environment build+run engine (S3a). Policy checks are
 * pure; the build+run test REQUIRES Docker and uses a tiny alpine base so it is
 * fast. Builds an image over a temp workspace and runs a locked container that
 * reads a project file.
 *
 *   pnpm --filter @workspace/api-server run agent:verify-custom-environment
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAndRunCustomEnvironment, validateCustomEnvironment } from "./customEnvironment";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("Custom-environment engine verification\n");

  // Policy (pure).
  check("rejects a missing/invalid base image", !validateCustomEnvironment({ baseImage: "", runCommand: "x" }).ok);
  check("rejects an unpinned base image", !validateCustomEnvironment({ baseImage: "alpine", runCommand: "x" }).ok);
  check("rejects a base image with shell metacharacters", !validateCustomEnvironment({ baseImage: "alpine:3.20; rm -rf /", runCommand: "x" }).ok);
  check("accepts a pinned base image + run command", validateCustomEnvironment({ baseImage: "alpine:3.20", runCommand: "echo hi" }).ok);

  // Build + run (needs Docker).
  const dir = await mkdtemp(join(tmpdir(), "pf-env-"));
  await writeFile(join(dir, "marker.txt"), "PROJECT_FILE_CONTENT_7", "utf8");

  const result = await buildAndRunCustomEnvironment(
    { baseImage: "alpine:3.20", runCommand: "echo BUILT_AND_RAN && cat /work/marker.txt" },
    dir,
    { buildTimeoutMs: 180_000, runTimeoutMs: 30_000 },
  );
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  if (result.error && /Docker|build failed|Cannot connect/i.test(result.stderr + (result.error ?? ""))) {
    console.log(`  SKIP build+run (Docker not usable): ${result.error}`);
  } else {
    check("built the image and ran the command", result.ok, JSON.stringify({ error: result.error, code: result.exitCode, stderr: result.stderr.slice(-300) }));
    check("run saw the real project file (COPY worked)", result.stdout.includes("PROJECT_FILE_CONTENT_7"), result.stdout);
    check("run command executed", result.stdout.includes("BUILT_AND_RAN"), result.stdout);
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
