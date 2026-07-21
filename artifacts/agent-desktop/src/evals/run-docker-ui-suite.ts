import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const electronPath = require("electron") as string;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(
  packageRoot,
  "../agent-runtime/src/evals/fixtures/docker-typescript-workspace",
);
const dependencyCacheRepository = "pathforge-agent-dependencies-ui-eval";

const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
  (resolveResult, reject) => {
    const child = spawn(electronPath, [packageRoot], {
      cwd: packageRoot,
      windowsHide: true,
      env: {
        ...process.env,
        PATHFORGE_AGENT_DOCKER_UI_SMOKE: "1",
        PATHFORGE_AGENT_TEST_WORKSPACE: workspaceRoot,
        PATHFORGE_AGENT_DEPENDENCY_CACHE_REPOSITORY: dependencyCacheRepository,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Docker desktop UI evaluation timed out"));
    }, 300_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr });
    });
  },
);

const cacheTags = (
  await execFileAsync("docker", [
    "image",
    "ls",
    dependencyCacheRepository,
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ])
).stdout
  .split(/\r?\n/)
  .map((tag) => tag.trim())
  .filter(Boolean);
for (const tag of cacheTags) {
  await execFileAsync("docker", ["image", "rm", tag]).catch(() => undefined);
}

if (result.code !== 0 || !result.stdout.includes("PASS Docker desktop UI journey")) {
  console.error(result.stdout);
  console.error(result.stderr);
  throw new Error(`Docker desktop UI evaluation failed with exit code ${result.code}`);
}

console.log(result.stdout.trim());
