import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CustomEnvironmentSpec {
  baseImage: string;
  setupCommands?: string[];
  runCommand: string;
  dockerfile?: string;
}

export interface CustomEnvironmentResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  imageTag?: string;
  /** Set when we refused to build/run (policy) or the build/run failed to start. */
  error?: string;
  timedOut?: boolean;
}

// A conservative Docker image reference: registry/name[:tag][@digest]. Rejects
// spaces / shell metacharacters so the ref can't smuggle extra docker args.
const IMAGE_REF = /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;

/**
 * Validates a proposed custom environment before anything is built. Kept
 * intentionally light for the local single-user app (the learner is the trust
 * authority on their own machine), but still blocks the obvious footguns:
 * malformed image refs and unpinned (`:latest`) bases.
 */
export function validateCustomEnvironment(spec: CustomEnvironmentSpec): { ok: boolean; reason?: string } {
  if (!spec.baseImage || !IMAGE_REF.test(spec.baseImage)) {
    return { ok: false, reason: "Invalid or missing base image reference." };
  }
  if (!spec.baseImage.includes(":") && !spec.baseImage.includes("@")) {
    return { ok: false, reason: "Pin the base image with a tag or digest (e.g. rust:1.83-slim), not an implicit :latest." };
  }
  if (!spec.runCommand?.trim()) {
    return { ok: false, reason: "Missing run command." };
  }
  if (spec.dockerfile && !/^\s*FROM\s+\S+/im.test(spec.dockerfile)) {
    return { ok: false, reason: "A provided Dockerfile must start from a base image (FROM ...)." };
  }
  return { ok: true };
}

interface DockerRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runDocker(
  args: string[],
  options: { timeoutMs: number; dockerCommand?: string } = { timeoutMs: 120_000 },
): Promise<DockerRun> {
  return new Promise((resolve) => {
    const child = spawn(options.dockerCommand ?? "docker", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: DockerRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => finish({ exitCode: null, stdout, stderr: `${stderr}\n${String(err)}`, timedOut }));
    child.on("close", (code) => finish({ exitCode: code, stdout, stderr, timedOut }));
  });
}

/**
 * Builds a content-addressed image from an approved custom-environment spec and
 * runs its command over the learner's project files. The BUILD may use the
 * network (to install packages); the RUN is locked down — no network, dropped
 * capabilities, no new privileges, and CPU/memory/pid limits — mirroring the
 * lab sandbox. Nothing is written into the learner's real folder.
 */
export async function buildAndRunCustomEnvironment(
  spec: CustomEnvironmentSpec,
  workspaceRoot: string,
  options: { buildTimeoutMs?: number; runTimeoutMs?: number; dockerCommand?: string } = {},
): Promise<CustomEnvironmentResult> {
  const policy = validateCustomEnvironment(spec);
  if (!policy.ok) {
    return { ok: false, stdout: "", stderr: "", exitCode: null, error: policy.reason };
  }

  const dockerfileContent =
    spec.dockerfile ??
    [
      `FROM ${spec.baseImage}`,
      "WORKDIR /work",
      "COPY . /work",
      ...(spec.setupCommands ?? []).map((c) => `RUN ${c}`),
    ].join("\n");

  const tag = `pathforge-custom-${createHash("sha256").update(dockerfileContent).digest("hex").slice(0, 16)}:local`;
  const dockerCommand = options.dockerCommand;
  const dfDir = await mkdtemp(join(tmpdir(), "pf-df-"));
  const dockerfilePath = join(dfDir, "Dockerfile");

  try {
    await writeFile(dockerfilePath, dockerfileContent, "utf8");

    const build = await runDocker(
      ["build", "-f", dockerfilePath, "-t", tag, workspaceRoot],
      { timeoutMs: options.buildTimeoutMs ?? 300_000, dockerCommand },
    );
    if (build.exitCode !== 0) {
      return {
        ok: false, stdout: build.stdout, stderr: build.stderr, exitCode: build.exitCode,
        imageTag: tag, timedOut: build.timedOut,
        error: build.timedOut ? "Image build timed out." : "Image build failed.",
      };
    }

    const run = await runDocker(
      [
        "run", "--rm",
        "--network", "none",
        "--cpus", "2",
        "--memory", "1g",
        "--pids-limit", "512",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        "--workdir", "/work",
        tag,
        "sh", "-c", spec.runCommand,
      ],
      { timeoutMs: options.runTimeoutMs ?? 120_000, dockerCommand },
    );
    return {
      ok: run.exitCode === 0,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      imageTag: tag,
      timedOut: run.timedOut,
      ...(run.timedOut ? { error: "Run timed out." } : {}),
    };
  } finally {
    await rm(dfDir, { recursive: true, force: true }).catch(() => {});
  }
}
