import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createNodeRuntimePlan,
  createPythonRuntimePlan,
  type NodeRuntimePlanOptions,
  type PythonRuntimePlanOptions,
  type RuntimePlan,
} from "./runtime-plan";

export type RuntimeDetectionResult =
  | { status: "supported"; plan: RuntimePlan }
  | { status: "unsupported"; code: "UNSUPPORTED_RUNTIME"; message: string };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type PythonCapabilities = NonNullable<PythonRuntimePlanOptions["capabilities"]>;

function pyprojectHasBuildSystem(contents: string | null): boolean {
  return contents !== null && /^\s*\[build-system\]\s*$/m.test(contents);
}

function capabilitiesFromPackages(
  packages: ReadonlySet<string>,
  pyprojectContents: string | null,
  manager: "uv" | "pip",
): PythonCapabilities {
  return {
    pytest: packages.has("pytest"),
    mypy: packages.has("mypy"),
    build:
      pyprojectHasBuildSystem(pyprojectContents) &&
      (manager === "uv" || packages.has("build")),
  };
}

function validateUvLock(contents: string): { ok: true; packages: Set<string> } | { ok: false; reason: string } {
  const packages = new Set(
    [...contents.matchAll(/^name\s*=\s*"([^"]+)"\s*$/gm)].map((match) =>
      (match[1] ?? "").toLowerCase(),
    ),
  );
  for (const match of contents.matchAll(/^source\s*=\s*\{([^}]+)\}\s*$/gm)) {
    const source = match[1] ?? "";
    if (
      source.trim() !== 'registry = "https://pypi.org/simple"' &&
      source.trim() !== 'virtual = "."'
    ) {
      return { ok: false, reason: `uv.lock contains an unapproved package source: {${source.trim()}}` };
    }
  }
  for (const match of contents.matchAll(/\burl\s*=\s*"([^"]+)"/g)) {
    const url = match[1] ?? "";
    if (!url.startsWith("https://files.pythonhosted.org/")) {
      return { ok: false, reason: `uv.lock contains an unapproved artifact URL: ${url}` };
    }
  }
  if (/^source\s*=\s*\{[^}]*(?:git|editable|directory|path)\s*=/m.test(contents)) {
    return { ok: false, reason: "uv.lock contains a Git, editable, directory, or path dependency." };
  }
  return { ok: true, packages };
}

function parsePinnedRequirements(contents: string):
  | { ok: true; packages: Set<string>; hashesRequired: boolean }
  | { ok: false; reason: string } {
  const logicalLines: string[] = [];
  let pending = "";
  for (const rawLine of contents.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/(^|\s+)#.*$/, "").trim();
    if (!withoutComment && !pending) continue;
    const continued = withoutComment.endsWith("\\");
    pending += `${pending ? " " : ""}${continued ? withoutComment.slice(0, -1).trim() : withoutComment}`;
    if (!continued) {
      if (pending) logicalLines.push(pending);
      pending = "";
    }
  }
  if (pending) return { ok: false, reason: "requirements.txt ends with an unfinished continuation." };
  if (logicalLines.length === 0) {
    return { ok: false, reason: "requirements.txt does not contain any dependencies." };
  }

  const packages = new Set<string>();
  let hashed = 0;
  for (const line of logicalLines) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?==([A-Za-z0-9][A-Za-z0-9.!+_-]*)((?:\s+--hash=sha256:[a-fA-F0-9]{64})*)$/.exec(line);
    if (!match) {
      return {
        ok: false,
        reason: `requirements.txt must contain only exact package==version pins and optional SHA-256 hashes: ${line}`,
      };
    }
    packages.add((match[1] ?? "").toLowerCase().replaceAll("_", "-"));
    if ((match[3] ?? "").trim()) hashed += 1;
  }
  if (hashed > 0 && hashed !== logicalLines.length) {
    return {
      ok: false,
      reason: "requirements.txt mixes hashed and unhashed dependencies. Hash every entry or remove all hashes.",
    };
  }
  return { ok: true, packages, hashesRequired: hashed === logicalLines.length };
}

export interface RuntimeDetectorOptions {
  nodeBaseImage?: string;
  pythonBaseImage?: string;
  workspaceEdits?: ReadonlyArray<{ path: string; content: string }>;
}

/** Detects trusted runtime inputs from known files; it never invokes a model or project code. */
export class RuntimeDetector {
  constructor(private readonly options: RuntimeDetectorOptions = {}) {}

  private async hasFile(workspaceRoot: string, name: string): Promise<boolean> {
    if (this.options.workspaceEdits?.some((edit) => edit.path === name)) return true;
    return await exists(join(workspaceRoot, name));
  }

  private async readKnownFile(workspaceRoot: string, name: string): Promise<string> {
    const staged = this.options.workspaceEdits?.find((edit) => edit.path === name);
    return staged?.content ?? (await readFile(join(workspaceRoot, name), "utf8"));
  }

  async detect(workspaceRoot: string): Promise<RuntimeDetectionResult> {
    if (!(await stat(workspaceRoot)).isDirectory()) {
      return {
        status: "unsupported",
        code: "UNSUPPORTED_RUNTIME",
        message: "The selected workspace is not a directory.",
      };
    }
    const packageJsonPath = join(workspaceRoot, "package.json");
    if (await this.hasFile(workspaceRoot, "package.json")) {
      return await this.detectNode(workspaceRoot, packageJsonPath);
    }

    const pyprojectPath = join(workspaceRoot, "pyproject.toml");
    const requirementsPath = join(workspaceRoot, "requirements.txt");
    if (await this.hasFile(workspaceRoot, "pyproject.toml")) {
      const pyprojectContents = await this.readKnownFile(workspaceRoot, "pyproject.toml");
      const uvLockPath = join(workspaceRoot, "uv.lock");
      if (await this.hasFile(workspaceRoot, "uv.lock")) {
        const validation = validateUvLock(await this.readKnownFile(workspaceRoot, "uv.lock"));
        if (!validation.ok) {
          return { status: "unsupported", code: "UNSUPPORTED_RUNTIME", message: validation.reason };
        }
        return {
          status: "supported",
          plan: createPythonRuntimePlan({
            ...(this.options.pythonBaseImage
              ? { baseImage: this.options.pythonBaseImage }
              : {}),
            dependency: { manager: "uv" },
            capabilities: capabilitiesFromPackages(
              validation.packages,
              pyprojectContents,
              "uv",
            ),
          }),
        };
      }
      if (await this.hasFile(workspaceRoot, "requirements.txt")) {
        return this.detectPip(
          await this.readKnownFile(workspaceRoot, "requirements.txt"),
          pyprojectContents,
        );
      }
      return {
        status: "unsupported",
        code: "UNSUPPORTED_RUNTIME",
        message: "A Python project was detected, but it needs uv.lock or a safely pinned requirements.txt.",
      };
    }
    if (await this.hasFile(workspaceRoot, "requirements.txt")) {
      return this.detectPip(
        await this.readKnownFile(workspaceRoot, "requirements.txt"),
        null,
      );
    }

    return {
      status: "unsupported",
      code: "UNSUPPORTED_RUNTIME",
      message: "No supported runtime was detected. Add package.json, or add Python's pyproject.toml/requirements.txt with a supported lock file.",
    };
  }

  private detectPip(
    requirementsContents: string,
    pyprojectContents: string | null,
  ): RuntimeDetectionResult {
    const validation = parsePinnedRequirements(requirementsContents);
    if (!validation.ok) {
      return {
        status: "unsupported",
        code: "UNSUPPORTED_RUNTIME",
        message: validation.reason,
      };
    }
    return {
      status: "supported",
      plan: createPythonRuntimePlan({
        ...(this.options.pythonBaseImage
          ? { baseImage: this.options.pythonBaseImage }
          : {}),
        dependency: { manager: "pip", hashesRequired: validation.hashesRequired },
        capabilities: capabilitiesFromPackages(
          validation.packages,
          pyprojectContents,
          "pip",
        ),
      }),
    };
  }

  private async detectNode(
    workspaceRoot: string,
    _packageJsonPath: string,
  ): Promise<RuntimeDetectionResult> {
    if (!(await this.hasFile(workspaceRoot, "package.json"))) {
      return {
        status: "unsupported",
        code: "UNSUPPORTED_RUNTIME",
        message: "package.json was not found.",
      };
    }
    try {
      const parsed: unknown = JSON.parse(
        await this.readKnownFile(workspaceRoot, "package.json"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    } catch {
      return {
        status: "unsupported",
        code: "UNSUPPORTED_RUNTIME",
        message: "package.json is not valid JSON, so a safe Node runtime plan cannot be created.",
      };
    }

    let dependency: NodeRuntimePlanOptions["dependency"] = null;
    if (await this.hasFile(workspaceRoot, "pnpm-lock.yaml")) {
      dependency = { manager: "pnpm", lockfile: "pnpm-lock.yaml" };
    } else if (await this.hasFile(workspaceRoot, "package-lock.json")) {
      dependency = { manager: "npm", lockfile: "package-lock.json" };
    } else if (await this.hasFile(workspaceRoot, "npm-shrinkwrap.json")) {
      dependency = { manager: "npm", lockfile: "npm-shrinkwrap.json" };
    }

    return {
      status: "supported",
      plan: createNodeRuntimePlan({
        ...(this.options.nodeBaseImage ? { baseImage: this.options.nodeBaseImage } : {}),
        dependency,
      }),
    };
  }
}
