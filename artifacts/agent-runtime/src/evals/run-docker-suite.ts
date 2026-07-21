import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AgentDecision, ModelTurnContext } from "../contracts";
import type { ModelAdapter } from "../model/model-adapter";
import { createNodeRuntimePlan } from "../environment/runtime-plan";
import { RuntimePolicy } from "../environment/runtime-policy";
import { AllowlistedCommandPolicy } from "../policy/command-policy";
import { AgentHarness } from "../runtime/harness";
import { DockerSandbox } from "../sandbox/docker-sandbox";
import type { SandboxCommandRequest, SandboxSession } from "../sandbox/agent-sandbox";
import { SandboxManager } from "../sandbox/sandbox-manager";
import { RunCommandTool } from "../tools/run-command-tool";
import { ToolRegistry } from "../tools/tool";

const execFileAsync = promisify(execFile);
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "docker-workspace",
);
const typescriptFixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "docker-typescript-workspace",
);
const temporaryRoot = await mkdtemp(join(tmpdir(), "pathforge-docker-eval-"));
const workspaceRoot = join(temporaryRoot, "workspace");
const typescriptWorkspaceRoot = join(temporaryRoot, "typescript-workspace");
await cp(fixtureRoot, workspaceRoot, { recursive: true });
await cp(typescriptFixtureRoot, typescriptWorkspaceRoot, { recursive: true });
await writeFile(join(workspaceRoot, ".env"), "OPENROUTER_API_KEY=must-not-enter-sandbox\n", "utf8");
await writeFile(
  join(typescriptWorkspaceRoot, "tsconfig.tsbuildinfo"),
  "stale host build metadata must not enter Docker\n",
  "utf8",
);
const cacheSaltDirectory = join(typescriptWorkspaceRoot, "cache-salt");
await mkdir(cacheSaltDirectory, { recursive: true });
await writeFile(
  join(cacheSaltDirectory, "package.json"),
  JSON.stringify({ name: "cache-salt", private: true, description: temporaryRoot }),
  "utf8",
);

const runtimePolicy = new RuntimePolicy();
const dependencyFreeNodePlan = runtimePolicy.requireApproved(createNodeRuntimePlan());
const lockedPnpmNodePlan = runtimePolicy.requireApproved(
  createNodeRuntimePlan({ dependency: { manager: "pnpm", lockfile: "pnpm-lock.yaml" } }),
);
const sandbox = new DockerSandbox({ runtimePlan: dependencyFreeNodePlan });
const dependencyCacheRepository = `pathforge-agent-dependencies-eval-${process.pid}-${Date.now()}`;
const dependencySandbox = new DockerSandbox({
  runtimePlan: lockedPnpmNodePlan,
  dependencyCacheMetadataPath: join(temporaryRoot, "dependency-cache-usage.json"),
  dependencyCacheRepository,
  maxDependencyCacheEntries: 1,
});
const runAbort = new AbortController();
let session: SandboxSession | null = null;
let dependencySession: SandboxSession | null = null;
const dependencyCacheImages = new Set<string>();
let failures = 0;

function command(
  executable: string,
  arguments_: string[],
  overrides: Partial<SandboxCommandRequest> = {},
): SandboxCommandRequest {
  return {
    command: executable,
    arguments: arguments_,
    workingDirectory: ".",
    timeoutMs: 10_000,
    maxOutputCharacters: 10_000,
    ...overrides,
  };
}

function report(name: string, passed: boolean, detail?: string): void {
  if (passed) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

try {
  session = await sandbox.prepare({
    runId: "docker-isolation-eval",
    workspaceRoot,
    signal: runAbort.signal,
  });

  const inspection = JSON.parse(
    (await execFileAsync("docker", ["inspect", session.id])).stdout,
  ) as Array<{
    Config: { User: string };
    HostConfig: {
      NetworkMode: string;
      Memory: number;
      NanoCpus: number;
      PidsLimit: number;
      CapDrop: string[] | null;
      SecurityOpt: string[] | null;
    };
  }>;
  const container = inspection[0];
  report(
    "container starts with non-root identity and hardened resource settings",
    container?.Config.User === "10001:10001" &&
      container.HostConfig.NetworkMode === "none" &&
      container.HostConfig.Memory === 1_073_741_824 &&
      container.HostConfig.NanoCpus === 1_000_000_000 &&
      container.HostConfig.PidsLimit === 128 &&
      container.HostConfig.CapDrop?.includes("ALL") === true &&
      container.HostConfig.SecurityOpt?.some((value) => value.includes("no-new-privileges")) ===
        true,
  );

  const testResult = await sandbox.execute(
    session,
    command("pnpm", ["test"]),
    { signal: runAbort.signal },
  );
  report(
    "dependency-free fixture test runs as the sandbox user",
    testResult.exitCode === 0 &&
      testResult.stdout.includes("DEPENDENCY_FREE_TEST_PASSED") &&
      testResult.stdout.includes("SANDBOX_USER_ID=10001"),
    testResult.stderr,
  );

  const buildResult = await sandbox.execute(
    session,
    command("pnpm", ["run", "build"]),
    { signal: runAbort.signal },
  );
  const sandboxCreatedFile = await sandbox.readFile(
    session,
    "sandbox-created.txt",
    { signal: runAbort.signal },
  );
  report(
    "sandbox writes stay in the copied workspace instead of the host fixture",
    buildResult.exitCode === 0 &&
      sandboxCreatedFile === "created only in Docker" &&
      !(await fileExists(join(workspaceRoot, "sandbox-created.txt"))),
    buildResult.stderr,
  );

  let secretStayedOut = false;
  try {
    await sandbox.readFile(session, ".env", { signal: runAbort.signal });
  } catch {
    secretStayedOut = true;
  }
  report("filtered workspace snapshot keeps .env secrets out of Docker", secretStayedOut);

  const timeoutResult = await sandbox.execute(
    session,
    command("node", ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 300 }),
    { signal: runAbort.signal },
  );
  report("long commands are stopped by the requested timeout", timeoutResult.timedOut);

  const outputResult = await sandbox.execute(
    session,
    command("node", ["-e", "process.stdout.write('x'.repeat(5000))"], {
      maxOutputCharacters: 128,
    }),
    { signal: runAbort.signal },
  );
  report(
    "large command output is truncated at the trusted limit",
    outputResult.exitCode === 0 && outputResult.truncated && outputResult.stdout.length === 128,
  );

  const networkResult = await sandbox.execute(
    session,
    command("node", [
      "-e",
      "const net=require('node:net');const s=net.connect(80,'1.1.1.1');s.on('connect',()=>{console.log('NETWORK_OPEN');process.exit(7)});s.on('error',()=>console.log('NETWORK_BLOCKED'));setTimeout(()=>process.exit(0),1000)",
    ], { timeoutMs: 3_000 }),
    { signal: runAbort.signal },
  );
  report(
    "agent command has no network route",
    networkResult.exitCode === 0 &&
      networkResult.stdout.includes("NETWORK_BLOCKED") &&
      !networkResult.stdout.includes("NETWORK_OPEN"),
    networkResult.stderr,
  );

  let traversalBlocked = false;
  try {
    await sandbox.readFile(session, "../source.txt", { signal: runAbort.signal });
  } catch {
    traversalBlocked = true;
  }
  report("sandbox file reads reject parent traversal", traversalBlocked);

  const disposedId = session.id;
  await sandbox.dispose(session);
  session = null;
  let removed = false;
  try {
    await execFileAsync("docker", ["inspect", disposedId]);
  } catch {
    removed = true;
  }
  report("disposing a session removes its container", removed);

  const cancelSandbox = new DockerSandbox({ runtimePlan: dependencyFreeNodePlan });
  const cancelController = new AbortController();
  let cancelSession: SandboxSession | null = await cancelSandbox.prepare({
    runId: "docker-cancellation-eval",
    workspaceRoot,
    signal: cancelController.signal,
  });
  const cancelStartedAt = Date.now();
  const pendingCommand = cancelSandbox.execute(
    cancelSession,
    command("node", ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30_000 }),
    { signal: cancelController.signal },
  );
  setTimeout(() => cancelController.abort(new Error("Evaluation cancelled command")), 300);
  let cancellationReachedDocker = false;
  try {
    await pendingCommand;
  } catch (error) {
    cancellationReachedDocker =
      error instanceof Error && error.message === "Evaluation cancelled command";
  }
  await cancelSandbox.dispose(cancelSession);
  cancelSession = null;
  report(
    "cancellation stops Docker execution promptly and still permits cleanup",
    cancellationReachedDocker && Date.now() - cancelStartedAt < 5_000,
  );

  class DockerCommandModel implements ModelAdapter {
    async decide(context: ModelTurnContext): Promise<AgentDecision> {
      if (context.observations.length === 0) {
        return {
          type: "tool_call",
          call: {
            id: "docker-test-command",
            name: "run_command",
            arguments: { command: "pnpm", arguments: ["test"], workingDirectory: "." },
          },
        };
      }
      return {
        type: "final",
        response: "The dependency-free test passed inside the Docker sandbox.",
        proposedActions: [{ type: "none", reason: "The sandbox result is sufficient." }],
      };
    }
  }

  const harnessDocker = new DockerSandbox({ runtimePlan: dependencyFreeNodePlan });
  const dockerHarness = new AgentHarness({
    model: new DockerCommandModel(),
    tools: new ToolRegistry([
      new RunCommandTool({
        policy: new AllowlistedCommandPolicy(),
        sandboxes: new SandboxManager(harnessDocker, workspaceRoot),
      }),
    ]),
  });
  const harnessEvents = [];
  for await (const event of dockerHarness.runTurn({
    runId: "docker-harness-eval",
    workspaceId: "docker-fixture",
    preferredLanguage: "English",
    currentNode: { id: 1, title: "Run the fixture test" },
    messages: [],
    userMessage: "Run the test in the sandbox.",
  })) {
    harnessEvents.push(event);
  }
  const harnessToolOutput = harnessEvents.find((event) => event.type === "tool_completed");
  const remainingHarnessContainers = (
    await execFileAsync("docker", [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      "name=pathforge-agent-docker-harness-eval",
    ])
  ).stdout.trim();
  report(
    "full model-policy-tool-Docker loop returns evidence and leaves no container",
    harnessToolOutput?.type === "tool_completed" &&
      (harnessToolOutput.output as Record<string, unknown>)["ok"] === true &&
      String((harnessToolOutput.output as Record<string, unknown>)["stdout"]).includes(
        "DEPENDENCY_FREE_TEST_PASSED",
      ) &&
      harnessEvents.some((event) => event.type === "completed") &&
      remainingHarnessContainers === "",
  );

  const dependencyAbort = new AbortController();
  dependencySession = await dependencySandbox.prepare({
    runId: "docker-locked-dependency-eval",
    workspaceRoot: typescriptWorkspaceRoot,
    signal: dependencyAbort.signal,
  });
  const coldCacheImage = dependencySession.dependencyCacheImage;
  if (coldCacheImage) dependencyCacheImages.add(coldCacheImage);
  const dependencyInspection = JSON.parse(
    (await execFileAsync("docker", ["inspect", dependencySession.id])).stdout,
  ) as Array<{ NetworkSettings: { Networks: Record<string, unknown> } }>;
  const typecheckResult = await dependencySandbox.execute(
    dependencySession,
    command("pnpm", ["run", "typecheck"], { timeoutMs: 30_000 }),
    { signal: dependencyAbort.signal },
  );
  report(
    "locked TypeScript dependency installs before source execution and network is detached",
    typecheckResult.exitCode === 0 &&
      dependencySession.dependencyCache === "miss" &&
      Object.keys(dependencyInspection[0]?.NetworkSettings.Networks ?? {}).length === 0,
    typecheckResult.stderr,
  );

  let staleBuildMetadataStayedOut = false;
  try {
    await dependencySandbox.readFile(dependencySession, "tsconfig.tsbuildinfo", {
      signal: dependencyAbort.signal,
    });
  } catch {
    staleBuildMetadataStayedOut = true;
  }
  report(
    "stale host TypeScript build metadata stays out of the clean snapshot",
    staleBuildMetadataStayedOut,
  );

  let lifecycleScriptStayedDisabled = false;
  try {
    await dependencySandbox.readFile(dependencySession, "POSTINSTALL_RAN", {
      signal: dependencyAbort.signal,
    });
  } catch {
    lifecycleScriptStayedDisabled = true;
  }
  report(
    "dependency lifecycle scripts stay disabled and host receives no node_modules",
    lifecycleScriptStayedDisabled &&
      !(await fileExists(join(typescriptWorkspaceRoot, "node_modules"))) &&
      !(await fileExists(join(typescriptWorkspaceRoot, "POSTINSTALL_RAN"))),
  );
  await dependencySandbox.dispose(dependencySession);
  dependencySession = null;

  dependencySession = await dependencySandbox.prepare({
    runId: "docker-warm-dependency-cache-eval",
    workspaceRoot: typescriptWorkspaceRoot,
    signal: dependencyAbort.signal,
  });
  const warmInspection = JSON.parse(
    (await execFileAsync("docker", ["inspect", dependencySession.id])).stdout,
  ) as Array<{ HostConfig: { NetworkMode: string } }>;
  const warmTypecheck = await dependencySandbox.execute(
    dependencySession,
    command("pnpm", ["run", "typecheck"], { timeoutMs: 30_000 }),
    { signal: dependencyAbort.signal },
  );
  report(
    "matching runtime and manifests reuse the dependency image without build networking",
    dependencySession.dependencyCache === "hit" &&
      dependencySession.dependencyCacheImage === coldCacheImage &&
      warmTypecheck.exitCode === 0 &&
      warmInspection[0]?.HostConfig.NetworkMode === "none",
    JSON.stringify(warmTypecheck),
  );
  const activeClear = await dependencySandbox.clearDependencyCaches();
  report(
    "cache clearing retains an image that backs an active sandbox",
    activeClear.removed.length === 0 &&
      activeClear.retained.length === 1 &&
      activeClear.retained[0] === coldCacheImage,
  );
  await dependencySandbox.dispose(dependencySession);
  dependencySession = null;

  await writeFile(
    join(cacheSaltDirectory, "package.json"),
    JSON.stringify({ name: "cache-salt", private: true, description: `${temporaryRoot}-changed` }),
    "utf8",
  );
  dependencySession = await dependencySandbox.prepare({
    runId: "docker-invalidated-dependency-cache-eval",
    workspaceRoot: typescriptWorkspaceRoot,
    signal: dependencyAbort.signal,
  });
  if (dependencySession.dependencyCacheImage) {
    dependencyCacheImages.add(dependencySession.dependencyCacheImage);
  }
  report(
    "changing a dependency manifest creates a new cache entry",
    dependencySession.dependencyCache === "miss" &&
      dependencySession.dependencyCacheImage !== coldCacheImage,
  );
  await dependencySandbox.dispose(dependencySession);
  dependencySession = null;
  let coldCacheWasEvicted = false;
  if (coldCacheImage) {
    try {
      await execFileAsync("docker", ["image", "inspect", coldCacheImage]);
    } catch {
      coldCacheWasEvicted = true;
    }
  }
  const boundedInventory = await dependencySandbox.listDependencyCaches();
  report(
    "least-recently-used cache eviction respects the configured entry limit",
    coldCacheWasEvicted && boundedInventory.entries.length === 1,
  );

  const cleared = await dependencySandbox.clearDependencyCaches();
  const emptyInventory = await dependencySandbox.listDependencyCaches();
  report(
    "cache clearing removes only the labelled evaluation cache",
    cleared.removed.length === 1 && cleared.retained.length === 0 && emptyInventory.entries.length === 0,
  );
} finally {
  if (session) {
    await sandbox.dispose(session).catch(() => undefined);
  }
  if (dependencySession) {
    await dependencySandbox.dispose(dependencySession).catch(() => undefined);
  }
  for (const image of dependencyCacheImages) {
    await execFileAsync("docker", ["image", "rm", "--force", image]).catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("\nAll 19 Docker sandbox evals passed.");
}
