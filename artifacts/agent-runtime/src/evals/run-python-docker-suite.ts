import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RuntimeDetector } from "../environment/runtime-detector";
import { RuntimePolicy } from "../environment/runtime-policy";
import { DockerSandbox } from "../sandbox/docker-sandbox";
import type { SandboxCommandRequest, SandboxSession } from "../sandbox/agent-sandbox";
import { PreparePythonDependenciesTool } from "../tools/prepare-python-dependencies-tool";
import { WorkspaceAccess } from "../workspace/workspace-access";

const execFileAsync = promisify(execFile);
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "docker-python-workspace",
);
const pipFixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "docker-python-pip-workspace",
);
const looseFixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "docker-python-loose-workspace",
);
const temporaryRoot = await mkdtemp(join(tmpdir(), "pathforge-python-docker-eval-"));
const workspaceRoot = join(temporaryRoot, "workspace");
const pipWorkspaceRoot = join(temporaryRoot, "pip-workspace");
const looseWorkspaceRoot = join(temporaryRoot, "loose-workspace");
await cp(fixtureRoot, workspaceRoot, { recursive: true });
await cp(pipFixtureRoot, pipWorkspaceRoot, { recursive: true });
await cp(looseFixtureRoot, looseWorkspaceRoot, { recursive: true });

const detector = new RuntimeDetector();
const uvDetection = await detector.detect(workspaceRoot);
const pipDetection = await detector.detect(pipWorkspaceRoot);
if (uvDetection.status !== "supported" || pipDetection.status !== "supported") {
  throw new Error("Python Docker fixtures did not produce supported runtime plans");
}
const runtimePolicy = new RuntimePolicy();
const runtimePlan = runtimePolicy.requireApproved(uvDetection.plan);
const pipRuntimePlan = runtimePolicy.requireApproved(pipDetection.plan);
const cacheRepository = `pathforge-python-dependencies-eval-${process.pid}-${Date.now()}`;
const sandbox = new DockerSandbox({
  runtimePlan,
  dependencyCacheMetadataPath: join(temporaryRoot, "dependency-cache-usage.json"),
  dependencyCacheRepository: cacheRepository,
  maxDependencyCacheEntries: 1,
});
const pipSandbox = new DockerSandbox({
  runtimePlan: pipRuntimePlan,
  dependencyCacheMetadataPath: join(temporaryRoot, "pip-dependency-cache-usage.json"),
  dependencyCacheRepository: `pathforge-python-pip-dependencies-eval-${process.pid}-${Date.now()}`,
  maxDependencyCacheEntries: 1,
});
const abort = new AbortController();
let session: SandboxSession | null = null;
let pipSession: SandboxSession | null = null;
let preparedSandbox: DockerSandbox | null = null;
let preparedSession: SandboxSession | null = null;
let failures = 0;

function report(name: string, passed: boolean, detail?: string): void {
  if (passed) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function command(
  arguments_: string[],
  executable = "uv",
): SandboxCommandRequest {
  return {
    command: executable,
    arguments: arguments_,
    workingDirectory: ".",
    timeoutMs: 60_000,
    maxOutputCharacters: 20_000,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

try {
  const preflight = await sandbox.preflight();
  report(
    "trusted Python 3.13 plus uv sandbox image is available",
    preflight.ready,
    preflight.message,
  );

  session = await sandbox.prepare({
    runId: "python-cold-cache-eval",
    workspaceRoot,
    signal: abort.signal,
  });
  const coldImage = session.dependencyCacheImage;
  const coldInspection = JSON.parse(
    (await execFileAsync("docker", ["inspect", session.id])).stdout,
  ) as Array<{
    Config: { User: string };
    NetworkSettings: { Networks: Record<string, unknown> };
  }>;
  const coldTest = await sandbox.execute(
    session,
    command(["run", "--offline", "--frozen", "--no-sync", "pytest"]),
    { signal: abort.signal },
  );
  report(
    "cold uv sync installs the lockfile, detaches networking, and runs pytest",
    session.dependencyCache === "miss" &&
      coldTest.exitCode === 0 &&
      coldTest.stdout.includes("1 passed") &&
      coldInspection[0]?.Config.User === "10001:10001" &&
      Object.keys(coldInspection[0]?.NetworkSettings.Networks ?? {}).length === 0,
    JSON.stringify(coldTest),
  );
  report(
    "Python virtual environment stays in Docker rather than the host workspace",
    !(await exists(join(workspaceRoot, ".venv"))),
  );
  await sandbox.dispose(session);
  session = null;

  session = await sandbox.prepare({
    runId: "python-warm-cache-eval",
    workspaceRoot,
    signal: abort.signal,
  });
  const warmInspection = JSON.parse(
    (await execFileAsync("docker", ["inspect", session.id])).stdout,
  ) as Array<{ HostConfig: { NetworkMode: string } }>;
  const warmTest = await sandbox.execute(
    session,
    command(["run", "--offline", "--frozen", "--no-sync", "pytest"]),
    { signal: abort.signal },
  );
  report(
    "warm Python run reuses the dependency image completely offline",
    session.dependencyCache === "hit" &&
      session.dependencyCacheImage === coldImage &&
      warmInspection[0]?.HostConfig.NetworkMode === "none" &&
      warmTest.exitCode === 0 &&
      warmTest.stdout.includes("1 passed"),
    JSON.stringify(warmTest),
  );
  await sandbox.dispose(session);
  session = null;

  const cleared = await sandbox.clearDependencyCaches();
  const inventory = await sandbox.listDependencyCaches();
  report(
    "Python evaluation cache is labelled, discoverable, and removable",
    cleared.removed.length === 1 && inventory.entries.length === 0,
  );

  pipSession = await pipSandbox.prepare({
    runId: "python-pip-cold-cache-eval",
    workspaceRoot: pipWorkspaceRoot,
    signal: abort.signal,
  });
  const pipColdImage = pipSession.dependencyCacheImage;
  const pipColdInspection = JSON.parse(
    (await execFileAsync("docker", ["inspect", pipSession.id])).stdout,
  ) as Array<{ NetworkSettings: { Networks: Record<string, unknown> } }>;
  const pipColdTest = await pipSandbox.execute(
    pipSession,
    command(["-m", "pytest"], "python"),
    { signal: abort.signal },
  );
  report(
    "cold pinned pip install uses binary packages, detaches networking, and runs pytest",
    pipSession.runtime?.dependencyManager === "pip" &&
      pipSession.dependencyCache === "miss" &&
      pipColdTest.exitCode === 0 &&
      pipColdTest.stdout.includes("1 passed") &&
      Object.keys(pipColdInspection[0]?.NetworkSettings.Networks ?? {}).length === 0,
    JSON.stringify(pipColdTest),
  );
  report(
    "pip target packages stay in Docker rather than the host workspace",
    !(await exists(join(pipWorkspaceRoot, ".pathforge-python-packages"))),
  );
  await pipSandbox.dispose(pipSession);
  pipSession = null;

  pipSession = await pipSandbox.prepare({
    runId: "python-pip-warm-cache-eval",
    workspaceRoot: pipWorkspaceRoot,
    signal: abort.signal,
  });
  const pipWarmInspection = JSON.parse(
    (await execFileAsync("docker", ["inspect", pipSession.id])).stdout,
  ) as Array<{ HostConfig: { NetworkMode: string } }>;
  const pipWarmTest = await pipSandbox.execute(
    pipSession,
    command(["-m", "pytest"], "python"),
    { signal: abort.signal },
  );
  report(
    "warm pip run reuses its dependency image completely offline",
    pipSession.dependencyCache === "hit" &&
      pipSession.dependencyCacheImage === pipColdImage &&
      pipWarmInspection[0]?.HostConfig.NetworkMode === "none" &&
      pipWarmTest.exitCode === 0 &&
      pipWarmTest.stdout.includes("1 passed"),
    JSON.stringify(pipWarmTest),
  );
  await pipSandbox.dispose(pipSession);
  pipSession = null;

  const pipCleared = await pipSandbox.clearDependencyCaches();
  const pipInventory = await pipSandbox.listDependencyCaches();
  report(
    "pip evaluation cache is independently labelled and removable",
    pipCleared.removed.length === 1 && pipInventory.entries.length === 0,
  );

  const looseWorkspace = new WorkspaceAccess(looseWorkspaceRoot);
  const preparation = (await new PreparePythonDependenciesTool({
    workspace: looseWorkspace,
  }).execute({ sourcePath: "requirements.in" })) as {
    staged: boolean;
    diff: string;
  };
  const stagedRequirements = await looseWorkspace.readTextFile("requirements.txt");
  await looseWorkspace.stageTextReplacement(
    "src/answer.py",
    "    return 42",
    "    return 43",
  );
  await looseWorkspace.stageTextReplacement(
    "tests/test_answer.py",
    "    assert answer() == 42",
    "    assert answer() == 43",
  );
  report(
    "dependency preparation resolves loose input into a staged hash-locked proposal",
    preparation.staged &&
      preparation.diff.includes("+++ b/requirements.txt") &&
      stagedRequirements.includes("--hash=sha256:") &&
      !(await exists(join(looseWorkspaceRoot, "requirements.txt"))),
  );

  const preparedDetection = await new RuntimeDetector({
    workspaceEdits: looseWorkspace.stagedEdits(),
  }).detect(looseWorkspaceRoot);
  if (preparedDetection.status !== "supported") {
    throw new Error(
      `The staged dependency lock did not produce a supported runtime: ${preparedDetection.message}`,
    );
  }
  preparedSandbox = new DockerSandbox({
    runtimePlan: runtimePolicy.requireApproved(preparedDetection.plan),
    dependencyCacheMetadataPath: join(temporaryRoot, "prepared-cache-usage.json"),
    dependencyCacheRepository: `pathforge-python-prepared-eval-${process.pid}-${Date.now()}`,
    maxDependencyCacheEntries: 1,
  });
  preparedSession = await preparedSandbox.prepare({
    runId: "python-prepared-overlay-eval",
    workspaceRoot: looseWorkspaceRoot,
    workspaceEdits: looseWorkspace.stagedEdits(),
    signal: abort.signal,
  });
  const preparedTest = await preparedSandbox.execute(
    preparedSession,
    command(["-m", "pytest"], "python"),
    { signal: abort.signal },
  );
  const stagedSource = await preparedSandbox.readFile(
    preparedSession,
    "src/answer.py",
    { signal: abort.signal },
  );
  report(
    "Docker installs and tests the staged lock plus source overlay without host writes",
    preparedSession.dependencyCache === "miss" &&
      preparedTest.exitCode === 0 &&
      preparedTest.stdout.includes("1 passed") &&
      stagedSource.includes("return 43") &&
      (await readFile(join(looseWorkspaceRoot, "src", "answer.py"), "utf8")).includes(
        "return 42",
      ) &&
      !(await exists(join(looseWorkspaceRoot, ".pathforge-python-packages"))),
    JSON.stringify(preparedTest),
  );
  await preparedSandbox.dispose(preparedSession);
  preparedSession = null;
  await preparedSandbox.clearDependencyCaches();
} finally {
  if (session) await sandbox.dispose(session).catch(() => undefined);
  if (pipSession) await pipSandbox.dispose(pipSession).catch(() => undefined);
  if (preparedSession && preparedSandbox) {
    await preparedSandbox.dispose(preparedSession).catch(() => undefined);
  }
  await sandbox.clearDependencyCaches().catch(() => undefined);
  await pipSandbox.clearDependencyCaches().catch(() => undefined);
  if (preparedSandbox) await preparedSandbox.clearDependencyCaches().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("\nAll 11 Python Docker evals passed.");
}
