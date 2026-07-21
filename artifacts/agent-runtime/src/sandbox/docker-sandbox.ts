import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  AgentSandbox,
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxOperationContext,
  SandboxPrepareRequest,
  SandboxSession,
} from "./agent-sandbox";
import type { ApprovedRuntimePlan, RuntimePlan } from "../environment/runtime-plan";

export interface DockerSandboxOptions {
  runtimePlan: ApprovedRuntimePlan;
  dockerCommand?: string;
  cpuLimit?: number;
  memoryLimit?: string;
  processLimit?: number;
  maxReadFileCharacters?: number;
  dependencyInstallTimeoutMs?: number;
  dependencyCacheMetadataPath?: string;
  dependencyCacheRepository?: string;
  maxDependencyCacheEntries?: number;
  maxDependencyCacheBytes?: number;
}

export interface DependencyCacheEntry {
  image: string;
  imageId: string;
  sizeBytes: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface DependencyCacheInventory {
  entries: DependencyCacheEntry[];
  totalBytes: number;
}

export interface DependencyCacheRemovalResult {
  removed: string[];
  retained: string[];
}

export interface DockerSandboxPreflight {
  dockerAvailable: boolean;
  imageAvailable: boolean;
  ready: boolean;
  message: string;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  stoppedBy: "abort" | "timeout" | null;
}

interface ProcessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputCharacters?: number;
}

const OUTPUT_TRUNCATION_MARKER = "\n… [output truncated; showing beginning and end] …\n";

class BoundedOutputBuffer {
  private full: string | null = "";
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maximum: number) {}

  append(text: string): void {
    this.totalCharacters += text.length;
    if (this.full !== null) {
      const combined = this.full + text;
      if (combined.length <= this.maximum) {
        this.full = combined;
        return;
      }
      const half = Math.ceil(this.maximum / 2);
      this.head = combined.slice(0, half);
      this.tail = combined.slice(-half);
      this.full = null;
      return;
    }
    this.tail = (this.tail + text).slice(-Math.ceil(this.maximum / 2));
  }

  get length(): number {
    return this.totalCharacters;
  }

  render(limit: number): string {
    if (limit <= 0) return "";
    if (this.full !== null) return this.full.slice(0, limit);
    if (this.totalCharacters <= limit) return this.head + this.tail;
    if (limit <= OUTPUT_TRUNCATION_MARKER.length) {
      return this.tail.slice(-limit);
    }
    const contentLimit = limit - OUTPUT_TRUNCATION_MARKER.length;
    const headLimit = Math.floor(contentLimit / 3);
    const tailLimit = contentLimit - headLimit;
    return `${this.head.slice(0, headLimit)}${OUTPUT_TRUNCATION_MARKER}${this.tail.slice(-tailLimit)}`;
  }
}

function safeRelativePath(path: string): boolean {
  if (path === ".") return true;
  if (!path || path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(path) || path.includes("\\") || path.includes("\0")) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function containerName(runId: string): string {
  const safeRunId = runId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 36);
  return `pathforge-agent-${safeRunId || "run"}-${randomUUID().slice(0, 8)}`;
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".pathforge-package-manager-cache",
  ".pathforge-python-packages",
  ".venv",
  "build",
  "dist",
  "node_modules",
]);
const EXCLUDED_SECRET_FILES = new Set([
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "id_dsa",
  "id_ed25519",
  "id_rsa",
]);

async function copyWorkspaceSnapshot(sourceRoot: string, destinationRoot: string): Promise<void> {
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    filter: async (source) => {
      const relativePath = relative(sourceRoot, source);
      if (!relativePath) return true;
      const segments = relativePath.split(sep);
      if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return false;
      const name = basename(source);
      if (
        name === ".env" ||
        name.startsWith(".env.") ||
        name.endsWith(".tsbuildinfo") ||
        name.endsWith(".pem") ||
        EXCLUDED_SECRET_FILES.has(name)
      ) {
        return false;
      }
      return !(await lstat(source)).isSymbolicLink();
    },
  });
  await makeDirectoriesWritable(destinationRoot);
}

async function makeDirectoriesWritable(directory: string): Promise<void> {
  await chmod(directory, 0o777);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.flatMap((entry) =>
      entry.isDirectory() ? [makeDirectoriesWritable(join(directory, entry.name))] : [],
    ),
  );
}

const ROOT_DEPENDENCY_FILES = new Set([
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
]);
const DEPENDENCY_CACHE_FORMAT = "pathforge-runtime-dependencies-v6";

async function copyDependencyManifests(sourceRoot: string, destinationRoot: string): Promise<void> {
  const visit = async (sourceDirectory: string): Promise<void> => {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const source = join(sourceDirectory, entry.name);
      const relativePath = relative(sourceRoot, source);
      if (entry.isDirectory()) {
        if (entry.name === "patches") {
          await cp(source, join(destinationRoot, relativePath), { recursive: true });
        } else {
          await visit(source);
        }
        continue;
      }
      if (
        entry.name !== "package.json" &&
        entry.name !== "pyproject.toml" &&
        !ROOT_DEPENDENCY_FILES.has(relativePath)
      ) {
        continue;
      }
      const destination = join(destinationRoot, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
  };

  await mkdir(destinationRoot, { recursive: true });
  await visit(sourceRoot);
  await makeDirectoriesWritable(destinationRoot);
}

async function applyWorkspaceEdits(
  destinationRoot: string,
  edits: ReadonlyArray<{ path: string; content: string }>,
  dependencyManifestsOnly = false,
): Promise<void> {
  for (const edit of edits) {
    if (!safeRelativePath(edit.path)) {
      throw new Error(`Staged edit path is not safe: ${edit.path}`);
    }
    const name = basename(edit.path);
    if (
      dependencyManifestsOnly &&
      name !== "package.json" &&
      name !== "pyproject.toml" &&
      !ROOT_DEPENDENCY_FILES.has(edit.path)
    ) {
      continue;
    }
    const destination = join(destinationRoot, ...edit.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, edit.content, "utf8");
  }
}

async function hashDependencyInputs(
  manifestRoot: string,
  baseImageId: string,
  runtimePlan: RuntimePlan,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(DEPENDENCY_CACHE_FORMAT);
  hash.update("\0");
  hash.update(baseImageId);
  hash.update("\0");
  hash.update(JSON.stringify(runtimePlan));

  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(manifestRoot, path).split(sep).join("/");
      hash.update("\0");
      hash.update(relativePath);
      hash.update("\0");
      hash.update(await readFile(path));
    }
  };

  await visit(manifestRoot);
  return hash.digest("hex");
}

/** Executes Docker CLI arguments directly; no shell command string is constructed. */
export class DockerSandbox implements AgentSandbox {
  private readonly activeContainerIds = new Set<string>();
  private readonly image: string;
  private readonly runtimePlan: RuntimePlan;
  private readonly dockerCommand: string;
  private readonly cpuLimit: number;
  private readonly memoryLimit: string;
  private readonly processLimit: number;
  private readonly maxReadFileCharacters: number;
  private readonly dependencyInstallTimeoutMs: number;
  private readonly dependencyCacheMetadataPath: string | undefined;
  private readonly dependencyCacheRepository: string;
  private readonly maxDependencyCacheEntries: number;
  private readonly maxDependencyCacheBytes: number;

  constructor(options: DockerSandboxOptions) {
    if (options.runtimePlan.approvedBy !== "pathforge-runtime-policy-v1") {
      throw new Error("DockerSandbox requires a runtime plan approved by RuntimePolicy");
    }
    this.runtimePlan = options.runtimePlan.plan;
    this.image = this.runtimePlan.baseImage;
    this.dockerCommand = options.dockerCommand ?? "docker";
    this.cpuLimit = options.cpuLimit ?? 1;
    this.memoryLimit = options.memoryLimit ?? "1g";
    this.processLimit = options.processLimit ?? 128;
    this.maxReadFileCharacters = options.maxReadFileCharacters ?? 100_000;
    this.dependencyInstallTimeoutMs = options.dependencyInstallTimeoutMs ?? 180_000;
    this.dependencyCacheMetadataPath = options.dependencyCacheMetadataPath;
    this.dependencyCacheRepository =
      options.dependencyCacheRepository ?? "pathforge-agent-dependencies";
    this.maxDependencyCacheEntries = options.maxDependencyCacheEntries ?? 5;
    this.maxDependencyCacheBytes = options.maxDependencyCacheBytes ?? 5 * 1024 ** 3;
    if (!Number.isInteger(this.dependencyInstallTimeoutMs) || this.dependencyInstallTimeoutMs <= 0) {
      throw new Error("dependencyInstallTimeoutMs must be a positive integer");
    }
    if (!Number.isInteger(this.maxDependencyCacheEntries) || this.maxDependencyCacheEntries <= 0) {
      throw new Error("maxDependencyCacheEntries must be a positive integer");
    }
    if (!Number.isInteger(this.maxDependencyCacheBytes) || this.maxDependencyCacheBytes <= 0) {
      throw new Error("maxDependencyCacheBytes must be a positive integer");
    }
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(this.dependencyCacheRepository)) {
      throw new Error("dependencyCacheRepository must be a lowercase Docker repository name");
    }
  }

  private async runDocker(
    arguments_: string[],
    options: ProcessOptions = {},
  ): Promise<ProcessResult> {
    const startedAt = Date.now();
    const maximum = options.maxOutputCharacters ?? 100_000;
    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(this.dockerCommand, arguments_, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutBuffer = new BoundedOutputBuffer(maximum);
      const stderrBuffer = new BoundedOutputBuffer(maximum);
      let stoppedBy: ProcessResult["stoppedBy"] = null;

      const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        if (target === "stdout") stdoutBuffer.append(text);
        else stderrBuffer.append(text);
      };
      child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

      const stop = (reason: "abort" | "timeout"): void => {
        if (stoppedBy) return;
        stoppedBy = reason;
        child.kill();
      };
      const onAbort = (): void => stop("abort");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const timer = options.timeoutMs
        ? setTimeout(() => stop("timeout"), options.timeoutMs)
        : undefined;

      child.once("error", (error) => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        const half = Math.floor(maximum / 2);
        let stdoutLimit = Math.min(stdoutBuffer.length, half);
        let stderrLimit = Math.min(stderrBuffer.length, half);
        let remaining = maximum - stdoutLimit - stderrLimit;
        const stdoutUncaptured = stdoutBuffer.length - stdoutLimit;
        const stdoutExtra = Math.min(stdoutUncaptured, remaining);
        stdoutLimit += stdoutExtra;
        remaining -= stdoutExtra;
        stderrLimit += Math.min(stderrBuffer.length - stderrLimit, remaining);
        const truncated = stdoutBuffer.length + stderrBuffer.length > maximum;
        resolve({
          exitCode,
          stdout: stdoutBuffer.render(stdoutLimit),
          stderr: stderrBuffer.render(stderrLimit),
          truncated,
          durationMs: Date.now() - startedAt,
          stoppedBy,
        });
      });
    });
  }

  private assertActive(session: SandboxSession): void {
    if (!this.activeContainerIds.has(session.id)) {
      throw new Error(`Docker sandbox session is not active: ${session.id}`);
    }
  }

  private async requireSuccess(arguments_: string[], description: string): Promise<ProcessResult> {
    const result = await this.runDocker(arguments_);
    if (result.exitCode !== 0) {
      throw new Error(`${description} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  }

  private async forceStop(containerId: string): Promise<void> {
    await this.runDocker(["kill", containerId], { timeoutMs: 10_000 }).catch(() => undefined);
  }

  async preflight(): Promise<DockerSandboxPreflight> {
    try {
      const version = await this.runDocker(
        ["version", "--format", "{{.Server.Version}}"],
        { timeoutMs: 5_000, maxOutputCharacters: 2_000 },
      );
      if (version.exitCode !== 0 || !version.stdout.trim()) {
        return {
          dockerAvailable: false,
          imageAvailable: false,
          ready: false,
          message: "Docker Desktop is not running or the Docker engine is unavailable.",
        };
      }
      const image = await this.runDocker(
        ["image", "inspect", this.image, "--format", "{{.Id}}"],
        { timeoutMs: 5_000, maxOutputCharacters: 2_000 },
      );
      if (image.exitCode !== 0 || !image.stdout.trim()) {
        return {
          dockerAvailable: true,
          imageAvailable: false,
          ready: false,
          message: `Sandbox image ${this.image} is missing. Build it before running commands.`,
        };
      }
      return {
        dockerAvailable: true,
        imageAvailable: true,
        ready: true,
        message: `Docker ${version.stdout.trim()} and ${this.image} are ready.`,
      };
    } catch (error) {
      return {
        dockerAvailable: false,
        imageAvailable: false,
        ready: false,
        message: error instanceof Error ? error.message : "Docker preflight failed.",
      };
    }
  }

  private async dependencyCacheImage(manifestRoot: string): Promise<string> {
    const baseImage = await this.requireSuccess(
      ["image", "inspect", this.image, "--format", "{{.Id}}"],
      "Inspecting the dependency base image",
    );
    const key = await hashDependencyInputs(
      manifestRoot,
      baseImage.stdout.trim(),
      this.runtimePlan,
    );
    return `${this.dependencyCacheRepository}:${key}`;
  }

  private async imageExists(image: string, signal: AbortSignal): Promise<boolean> {
    const result = await this.runDocker(
      ["image", "inspect", image, "--format", "{{.Id}}"],
      { signal, timeoutMs: 10_000, maxOutputCharacters: 2_000 },
    );
    return result.exitCode === 0 && Boolean(result.stdout.trim());
  }

  private async saveDependencyCache(
    containerId: string,
    image: string,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.runDocker(
      [
        "commit",
        "--pause=true",
        "--change",
        "LABEL pathforge.agent-dependency-cache=true",
        containerId,
        image,
      ],
      { signal, timeoutMs: 120_000, maxOutputCharacters: 4_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Saving the locked dependency cache failed: ${result.stderr.trim()}`);
    }
  }

  private async readDependencyCacheUsage(): Promise<Record<string, string>> {
    if (!this.dependencyCacheMetadataPath) return {};
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.dependencyCacheMetadataPath, "utf8"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && !Number.isNaN(Date.parse(entry[1])),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      return {};
    }
  }

  private async writeDependencyCacheUsage(usage: Record<string, string>): Promise<void> {
    if (!this.dependencyCacheMetadataPath) return;
    await mkdir(dirname(this.dependencyCacheMetadataPath), { recursive: true });
    await writeFile(
      this.dependencyCacheMetadataPath,
      `${JSON.stringify(usage, null, 2)}\n`,
      "utf8",
    );
  }

  private async touchDependencyCache(image: string): Promise<void> {
    if (!this.dependencyCacheMetadataPath) return;
    const usage = await this.readDependencyCacheUsage();
    usage[image] = new Date().toISOString();
    await this.writeDependencyCacheUsage(usage);
  }

  async listDependencyCaches(): Promise<DependencyCacheInventory> {
    const listed = await this.runDocker(
      [
        "image",
        "ls",
        "--quiet",
        "--filter",
        "label=pathforge.agent-dependency-cache=true",
      ],
      { timeoutMs: 15_000, maxOutputCharacters: 20_000 },
    );
    if (listed.exitCode !== 0) {
      throw new Error(`Listing dependency caches failed: ${listed.stderr.trim()}`);
    }
    const imageIds = [...new Set(listed.stdout.split(/\r?\n/).map((id) => id.trim()).filter(Boolean))];
    const usage = await this.readDependencyCacheUsage();
    const entries: DependencyCacheEntry[] = [];
    for (const imageId of imageIds) {
      const inspected = await this.runDocker(["image", "inspect", imageId], {
        timeoutMs: 15_000,
        maxOutputCharacters: 100_000,
      });
      if (inspected.exitCode !== 0) continue;
      const images = JSON.parse(inspected.stdout) as Array<{
        Id: string;
        RepoTags: string[] | null;
        Size: number;
        Created: string;
      }>;
      const image = images[0];
      const tag = image?.RepoTags?.find((candidate) =>
        candidate.startsWith(`${this.dependencyCacheRepository}:`),
      );
      if (!image || !tag) continue;
      entries.push({
        image: tag,
        imageId: image.Id,
        sizeBytes: image.Size,
        createdAt: image.Created,
        lastUsedAt: usage[tag] ?? image.Created,
      });
    }
    entries.sort((left, right) => Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt));
    return {
      entries,
      totalBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
    };
  }

  async clearDependencyCaches(): Promise<DependencyCacheRemovalResult> {
    const inventory = await this.listDependencyCaches();
    const removed: string[] = [];
    const retained: string[] = [];
    for (const entry of inventory.entries) {
      const result = await this.runDocker(["image", "rm", entry.image], {
        timeoutMs: 30_000,
        maxOutputCharacters: 4_000,
      });
      if (result.exitCode === 0) removed.push(entry.image);
      else retained.push(entry.image);
    }
    const usage = await this.readDependencyCacheUsage();
    for (const image of removed) delete usage[image];
    await this.writeDependencyCacheUsage(usage);
    return { removed, retained };
  }

  private async pruneDependencyCaches(protectedImage: string): Promise<void> {
    const inventory = await this.listDependencyCaches();
    let entryCount = inventory.entries.length;
    let totalBytes = inventory.totalBytes;
    const oldestFirst = [...inventory.entries].sort(
      (left, right) => Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt),
    );
    const usage = await this.readDependencyCacheUsage();
    for (const entry of oldestFirst) {
      if (
        entryCount <= this.maxDependencyCacheEntries &&
        totalBytes <= this.maxDependencyCacheBytes
      ) {
        break;
      }
      if (entry.image === protectedImage) continue;
      const removed = await this.runDocker(["image", "rm", entry.image], {
        timeoutMs: 30_000,
        maxOutputCharacters: 4_000,
      });
      if (removed.exitCode !== 0) continue;
      entryCount -= 1;
      totalBytes -= entry.sizeBytes;
      delete usage[entry.image];
    }
    await this.writeDependencyCacheUsage(usage);
  }

  private async installLockedDependencies(
    containerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const dependencies = this.runtimePlan.dependencies;
    if (dependencies.kind !== "locked") {
      throw new Error("The approved runtime plan does not include dependency installation");
    }
    const result = await this.runDocker(
      [
        "exec",
        "--user",
        "10001:10001",
        "--workdir",
        "/workspace",
        containerId,
        "timeout",
        "--kill-after=2s",
        `${(this.dependencyInstallTimeoutMs / 1_000).toFixed(3)}s`,
        dependencies.install.command,
        ...dependencies.install.arguments,
      ],
      {
        signal,
        timeoutMs: this.dependencyInstallTimeoutMs + 5_000,
        maxOutputCharacters: 30_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Locked dependency installation failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    const cacheCleanup = await this.runDocker(
      [
        "exec",
        "--user",
        "10001:10001",
        containerId,
        "rm",
        "--recursive",
        "--force",
        "--",
        ...dependencies.cleanupPaths,
      ],
      { signal, timeoutMs: 30_000, maxOutputCharacters: 2_000 },
    );
    if (cacheCleanup.exitCode !== 0) {
      throw new Error(`Cleaning the package-manager cache failed: ${cacheCleanup.stderr.trim()}`);
    }

    const disconnected = await this.runDocker(["network", "disconnect", "bridge", containerId], {
      signal,
      timeoutMs: 10_000,
    });
    if (disconnected.exitCode !== 0) {
      throw new Error(`Disconnecting dependency network failed: ${disconnected.stderr.trim()}`);
    }
    const networks = await this.requireSuccess(
      ["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerId],
      "Inspecting sandbox networks",
    );
    if (networks.stdout.trim() !== "{}") {
      throw new Error("Dependency container still has an attached network after installation");
    }
  }

  private async makeWorkspaceWritable(containerId: string, signal: AbortSignal): Promise<void> {
    const result = await this.runDocker(
      [
        "exec",
        "--user",
        "0:0",
        containerId,
        "find",
        "/workspace",
        "(",
        "-name",
        "node_modules",
        "-o",
        "-name",
        ".venv",
        "-o",
        "-name",
        ".pathforge-python-packages",
        ")",
        "-prune",
        "-o",
        "-mindepth",
        "1",
        "-exec",
        "chmod",
        "a+rwX",
        "{}",
        "+",
      ],
      { signal, timeoutMs: 30_000, maxOutputCharacters: 2_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Preparing sandbox workspace permissions failed: ${result.stderr.trim()}`);
    }
  }

  async prepare(request: SandboxPrepareRequest): Promise<SandboxSession> {
    if (request.signal.aborted) throw request.signal.reason ?? new Error("Run cancelled");
    const workspaceRoot = await realpath(request.workspaceRoot);
    if (!(await stat(workspaceRoot)).isDirectory()) {
      throw new Error(`Sandbox workspace is not a directory: ${workspaceRoot}`);
    }

    let containerId: string | null = null;
    let dependencyCache: SandboxSession["dependencyCache"] = "not_used";
    let dependencyCacheImage: string | undefined;
    let containerImage = this.image;
    let needsDependencyInstall = false;
    const stagingRoot = await mkdtemp(join(tmpdir(), "pathforge-sandbox-snapshot-"));
    const snapshotRoot = join(stagingRoot, "workspace");
    const manifestRoot = join(stagingRoot, "manifests");
    try {
      await copyWorkspaceSnapshot(workspaceRoot, snapshotRoot);
      await applyWorkspaceEdits(snapshotRoot, request.workspaceEdits ?? []);
      if (this.runtimePlan.dependencies.kind === "locked") {
        await copyDependencyManifests(workspaceRoot, manifestRoot);
        await applyWorkspaceEdits(manifestRoot, request.workspaceEdits ?? [], true);
        dependencyCacheImage = await this.dependencyCacheImage(manifestRoot);
        const cacheHit = await this.imageExists(dependencyCacheImage, request.signal);
        dependencyCache = cacheHit ? "hit" : "miss";
        containerImage = cacheHit ? dependencyCacheImage : this.image;
        needsDependencyInstall = !cacheHit;
        if (cacheHit) await this.touchDependencyCache(dependencyCacheImage);
      }
      const created = await this.runDocker([
        "create",
        "--name",
        containerName(request.runId),
        "--label",
        "pathforge.agent-sandbox=true",
        "--network",
        needsDependencyInstall ? "bridge" : "none",
        "--cpus",
        String(this.cpuLimit),
        "--memory",
        this.memoryLimit,
        "--pids-limit",
        String(this.processLimit),
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--workdir",
        "/workspace",
        containerImage,
      ], { signal: request.signal });
      if (created.exitCode !== 0) {
        throw new Error(`Docker container creation failed: ${created.stderr.trim()}`);
      }
      containerId = created.stdout.trim();
      if (!containerId) throw new Error("Docker returned an empty container ID");

      const initialCopyRoot =
        needsDependencyInstall ? manifestRoot : snapshotRoot;
      const copied = await this.runDocker(
        ["cp", `${initialCopyRoot}${sep}.`, `${containerId}:/workspace`],
        { signal: request.signal },
      );
      if (copied.exitCode !== 0) {
        throw new Error(`Copying the workspace into Docker failed: ${copied.stderr.trim()}`);
      }
      const started = await this.runDocker(["start", containerId], {
        signal: request.signal,
      });
      if (started.exitCode !== 0) {
        throw new Error(`Starting the Docker sandbox failed: ${started.stderr.trim()}`);
      }
      await this.makeWorkspaceWritable(containerId, request.signal);

      if (needsDependencyInstall) {
        await this.installLockedDependencies(containerId, request.signal);
        await this.saveDependencyCache(containerId, dependencyCacheImage!, request.signal);
        await this.touchDependencyCache(dependencyCacheImage!);
        await this.pruneDependencyCaches(dependencyCacheImage!);
        const sourceCopy = await this.runDocker(
          ["cp", `${snapshotRoot}${sep}.`, `${containerId}:/workspace`],
          { signal: request.signal },
        );
        if (sourceCopy.exitCode !== 0) {
          throw new Error(`Copying source after dependency installation failed: ${sourceCopy.stderr.trim()}`);
        }
        await this.makeWorkspaceWritable(containerId, request.signal);
      }

      this.activeContainerIds.add(containerId);
      return {
        id: containerId,
        runId: request.runId,
        workspaceRoot,
        runtime: {
          ecosystem: this.runtimePlan.ecosystem,
          version: this.runtimePlan.runtime.version,
          dependencyManager:
            this.runtimePlan.dependencies.kind === "locked"
              ? this.runtimePlan.dependencies.manager
              : null,
        },
        dependencyCache,
        dependencyCacheImage,
      };
    } catch (error) {
      if (containerId) {
        await this.runDocker(["rm", "--force", containerId], { timeoutMs: 10_000 }).catch(
          () => undefined,
        );
      }
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async execute(
    session: SandboxSession,
    request: SandboxCommandRequest,
    context: SandboxOperationContext,
  ): Promise<SandboxCommandResult> {
    this.assertActive(session);
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("Sandbox command timeout must be a positive integer");
    }
    if (!Number.isInteger(request.maxOutputCharacters) || request.maxOutputCharacters <= 0) {
      throw new Error("Sandbox output limit must be a positive integer");
    }
    const workingDirectory = request.workingDirectory ?? ".";
    if (!safeRelativePath(workingDirectory)) {
      throw new Error(`Unsafe sandbox working directory: ${workingDirectory}`);
    }

    const dockerArguments = [
      "exec",
      "--user",
      "10001:10001",
      "--workdir",
      workingDirectory === "." ? "/workspace" : `/workspace/${workingDirectory}`,
    ];
    for (const [name, value] of Object.entries(request.environment ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) {
        throw new Error(`Unsafe sandbox environment variable: ${name}`);
      }
      dockerArguments.push("--env", `${name}=${value}`);
    }
    dockerArguments.push(
      session.id,
      "timeout",
      "--kill-after=1s",
      `${(request.timeoutMs / 1_000).toFixed(3)}s`,
      request.command,
      ...request.arguments,
    );

    const result = await this.runDocker(dockerArguments, {
      signal: context.signal,
      timeoutMs: request.timeoutMs + 5_000,
      maxOutputCharacters: request.maxOutputCharacters,
    });
    if (result.stoppedBy) {
      await this.forceStop(session.id);
      if (result.stoppedBy === "abort") {
        throw context.signal.reason ?? new Error("Sandbox command cancelled");
      }
    }

    return {
      command: request.command,
      arguments: [...request.arguments],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut:
        result.stoppedBy === "timeout" || result.exitCode === 124 || result.exitCode === 137,
      truncated: result.truncated,
      durationMs: result.durationMs,
    };
  }

  async readFile(
    session: SandboxSession,
    path: string,
    context: SandboxOperationContext,
  ): Promise<string> {
    this.assertActive(session);
    if (!safeRelativePath(path)) throw new Error(`Unsafe sandbox file path: ${path}`);
    const result = await this.runDocker(
      ["exec", "--user", "10001:10001", session.id, "cat", "--", `/workspace/${path}`],
      { signal: context.signal, timeoutMs: 10_000, maxOutputCharacters: this.maxReadFileCharacters },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Reading sandbox file failed: ${result.stderr.trim()}`);
    }
    if (result.truncated) throw new Error(`Sandbox file exceeds the read limit: ${path}`);
    return result.stdout;
  }

  async dispose(session: SandboxSession): Promise<void> {
    this.assertActive(session);
    this.activeContainerIds.delete(session.id);
    await this.requireSuccess(["rm", "--force", session.id], "Removing Docker sandbox");
  }
}
