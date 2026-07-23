/**
 * Verifies the run_in_environment tool (S3c): runs the approved default command
 * and a command override in the built custom image. Requires Docker; uses a tiny
 * alpine base so it's fast.
 *
 *   pnpm --filter @workspace/api-server run agent:verify-run-in-environment
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunInEnvironmentTool } from "./run-in-environment-tool";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("run_in_environment tool verification\n");

  const dir = await mkdtemp(join(tmpdir(), "pf-envtool-"));
  await writeFile(join(dir, "marker.txt"), "ENV_RUN_MARKER_9", "utf8");
  const tool = new RunInEnvironmentTool(
    { baseImage: "alpine:3.20", setupCommands: [], runCommand: "echo DEFAULT_APPROVED_RUN && cat /work/marker.txt" },
    dir,
  );

  const def = (await tool.execute({})) as { ok?: boolean; stdout?: string; error?: string; stderr?: string };
  if (def.error && /Cannot connect|docker/i.test(String(def.error) + (def.stderr ?? ""))) {
    console.log(`  SKIP (Docker not usable): ${def.error}`);
  } else {
    check("runs the approved default command over the project", !!def.ok && !!def.stdout?.includes("DEFAULT_APPROVED_RUN") && !!def.stdout?.includes("ENV_RUN_MARKER_9"), JSON.stringify({ ok: def.ok, error: def.error }));
    const custom = (await tool.execute({ command: "echo CUSTOM_OVERRIDE_CMD" })) as { ok?: boolean; stdout?: string };
    check("runs a command override", !!custom.ok && !!custom.stdout?.includes("CUSTOM_OVERRIDE_CMD"), JSON.stringify(custom));
  }

  await rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
