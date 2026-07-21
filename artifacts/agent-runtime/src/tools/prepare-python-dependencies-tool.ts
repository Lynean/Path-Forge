import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { DEFAULT_PYTHON_SANDBOX_IMAGE } from "../environment/runtime-plan";
import type { SandboxManager } from "../sandbox/sandbox-manager";
import type { WorkspaceAccess } from "../workspace/workspace-access";
import type { AgentTool, AgentToolContext } from "./tool";

const execFileAsync = promisify(execFile);

function validateLooseRequirements(contents: string): void {
  const dependencyPattern =
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:===|==|~=|>=|<=|!=|>|<)[A-Za-z0-9][A-Za-z0-9.!+_*-]*(?:,(?:===|==|~=|>=|<=|!=|>|<)[A-Za-z0-9][A-Za-z0-9.!+_*-]*)*)?$/;
  const dependencies = contents
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s+)#.*$/, "").trim())
    .filter(Boolean);
  if (dependencies.length === 0) {
    throw new Error("The dependency input is empty");
  }
  for (const dependency of dependencies) {
    if (!dependencyPattern.test(dependency)) {
      throw new Error(
        `Dependency preparation accepts package names and version constraints only; URLs, options, paths, markers, and Git references are blocked: ${dependency}`,
      );
    }
  }
}

export interface PreparePythonDependenciesToolOptions {
  workspace: WorkspaceAccess;
  sandboxes?: SandboxManager;
  dockerCommand?: string;
  image?: string;
}

/**
 * Resolves a loose requirements input in a hardened, temporary networked container,
 * then stages the hash-locked result. The host project remains untouched.
 */
export class PreparePythonDependenciesTool implements AgentTool {
  readonly name = "prepare_python_dependencies";
  readonly description =
    "Resolve requirements.in or a loose requirements.txt into a fully pinned SHA-256 requirements.txt proposal. Resolution uses a temporary Docker container with network access; the generated lock is staged only and returned as a diff.";
  readonly inputSchema = z
    .object({
      sourcePath: z.enum(["requirements.in", "requirements.txt"]),
    })
    .strict();
  private readonly dockerCommand: string;
  private readonly image: string;

  constructor(private readonly options: PreparePythonDependenciesToolOptions) {
    this.dockerCommand = options.dockerCommand ?? "docker";
    this.image = options.image ?? DEFAULT_PYTHON_SANDBOX_IMAGE;
  }

  async execute(
    arguments_: Record<string, unknown>,
    context?: AgentToolContext,
  ): Promise<unknown> {
    const sourcePath = arguments_["sourcePath"] as "requirements.in" | "requirements.txt";
    const source = await this.options.workspace.readTextFile(sourcePath);
    validateLooseRequirements(source);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pathforge-python-prepare-"));
    const inputPath = join(temporaryRoot, "requirements.in");
    const outputPath = join(temporaryRoot, "requirements.txt");
    await writeFile(inputPath, source, "utf8");
    let containerId: string | null = null;
    const run = async (arguments__: string[], timeout = 180_000) =>
      await execFileAsync(this.dockerCommand, arguments__, {
        timeout,
        maxBuffer: 2_000_000,
        windowsHide: true,
        ...(context ? { signal: context.signal } : {}),
      });
    try {
      const created = await run([
        "create",
        "--label",
        "pathforge.agent-dependency-preparation=true",
        "--network",
        "bridge",
        "--cpus",
        "1",
        "--memory",
        "1g",
        "--pids-limit",
        "128",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--workdir",
        "/workspace",
        this.image,
      ]);
      containerId = created.stdout.trim();
      if (!containerId) throw new Error("Docker returned an empty preparation container ID");
      await run(["cp", inputPath, `${containerId}:/workspace/requirements.in`], 30_000);
      await run(["start", containerId], 30_000);
      await run([
        "exec",
        containerId,
        "uv",
        "pip",
        "compile",
        "--generate-hashes",
        "--no-emit-index-url",
        "--output-file",
        "/workspace/requirements.txt",
        "/workspace/requirements.in",
      ]);
      await run(["cp", `${containerId}:/workspace/requirements.txt`, outputPath], 30_000);
      const locked = await readFile(outputPath, "utf8");
      let oldText: string | null = null;
      try {
        oldText = await this.options.workspace.readTextFile("requirements.txt");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const staged = await this.options.workspace.stageTextReplacement(
        "requirements.txt",
        oldText,
        locked,
      );
      if (context && this.options.sandboxes) {
        await this.options.sandboxes.refreshRun(context.runId);
      }
      return {
        ok: true,
        staged: true,
        hostWorkspaceChanged: false,
        sourcePath,
        outputPath: "requirements.txt",
        dependencyCount: locked.split(/\r?\n/).filter((line) => /^[A-Za-z0-9]/.test(line)).length,
        ...staged,
      };
    } finally {
      if (containerId) {
        await execFileAsync(this.dockerCommand, ["rm", "--force", containerId], {
          timeout: 30_000,
          windowsHide: true,
        }).catch(() => undefined);
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
