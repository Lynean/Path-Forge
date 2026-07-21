import { z } from "zod/v4";

export const DEFAULT_NODE_SANDBOX_IMAGE = "pathforge-agent-sandbox:local";
export const DEFAULT_PYTHON_SANDBOX_IMAGE = "pathforge-python-sandbox:local";
export const PACKAGE_MANAGER_CACHE_ROOT = "/workspace/.pathforge-package-manager-cache";

const installPlanSchema = z.object({
  command: z.enum(["npm", "pnpm", "uv", "python"]),
  arguments: z.array(z.string().min(1)),
});

const nodeDependencyPlanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("locked"),
    manager: z.enum(["npm", "pnpm"]),
    lockfile: z.enum(["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml"]),
    install: installPlanSchema,
    cleanupPaths: z.array(z.string().min(1)).min(1),
  }),
]);

const nodeCommandPlanSchema = z.object({
  kind: z.literal("package-scripts"),
  packageManagers: z.array(z.enum(["npm", "pnpm"])).min(1),
  scripts: z.array(z.enum(["test", "typecheck", "build"])).min(1),
});

const exactCommandSchema = z.object({
  capability: z.enum(["test", "typecheck", "build"]),
  command: z.string().min(1),
  arguments: z.array(z.string()),
});

const pythonCommandPlanSchema = z.object({
  kind: z.literal("exact"),
  recipes: z.array(exactCommandSchema).min(1),
});

const networkPlanSchema = z.object({
  dependencyInstall: z.boolean(),
  execution: z.literal(false),
});

export const nodeRuntimePlanSchema = z.object({
  planVersion: z.literal(1),
  ecosystem: z.literal("node"),
  runtime: z.object({ name: z.literal("node"), version: z.literal("24") }),
  baseImage: z.string().min(1),
  dependencies: nodeDependencyPlanSchema,
  commands: nodeCommandPlanSchema,
  network: networkPlanSchema,
});

export const pythonRuntimePlanSchema = z.object({
  planVersion: z.literal(1),
  ecosystem: z.literal("python"),
  runtime: z.object({ name: z.literal("python"), version: z.literal("3.13") }),
  baseImage: z.string().min(1),
  dependencies: z.discriminatedUnion("manager", [
    z.object({
      kind: z.literal("locked"),
      manager: z.literal("uv"),
      lockfile: z.literal("uv.lock"),
      install: installPlanSchema,
      cleanupPaths: z.array(z.string().min(1)).min(1),
    }),
    z.object({
      kind: z.literal("locked"),
      manager: z.literal("pip"),
      lockfile: z.literal("requirements.txt"),
      hashesRequired: z.boolean(),
      install: installPlanSchema,
      cleanupPaths: z.array(z.string().min(1)).min(1),
    }),
  ]),
  commands: pythonCommandPlanSchema,
  network: networkPlanSchema,
});

export const runtimePlanSchema = z.discriminatedUnion("ecosystem", [
  nodeRuntimePlanSchema,
  pythonRuntimePlanSchema,
]);

export type NodeRuntimePlan = z.infer<typeof nodeRuntimePlanSchema>;
export type PythonRuntimePlan = z.infer<typeof pythonRuntimePlanSchema>;
export type RuntimePlan = z.infer<typeof runtimePlanSchema>;
export type ExactRuntimeCommand = z.infer<typeof exactCommandSchema>;

export interface ApprovedRuntimePlan {
  approvedBy: "pathforge-runtime-policy-v1";
  plan: RuntimePlan;
}

export interface NodeRuntimePlanOptions {
  baseImage?: string;
  dependency?:
    | { manager: "pnpm"; lockfile: "pnpm-lock.yaml" }
    | {
        manager: "npm";
        lockfile: "package-lock.json" | "npm-shrinkwrap.json";
      }
    | null;
}

export interface PythonRuntimePlanOptions {
  baseImage?: string;
  dependency?: { manager: "uv" } | { manager: "pip"; hashesRequired: boolean };
  capabilities?: {
    pytest?: boolean;
    mypy?: boolean;
    build?: boolean;
  };
}

export function createNodeRuntimePlan(options: NodeRuntimePlanOptions = {}): NodeRuntimePlan {
  const dependency = options.dependency ?? null;
  const dependencies: NodeRuntimePlan["dependencies"] = dependency
    ? dependency.manager === "pnpm"
      ? {
          kind: "locked",
          manager: "pnpm",
          lockfile: dependency.lockfile,
          install: {
            command: "pnpm",
            arguments: [
              "install",
              "--frozen-lockfile",
              "--ignore-scripts",
              "--reporter",
              "append-only",
              "--store-dir",
              `${PACKAGE_MANAGER_CACHE_ROOT}/pnpm`,
            ],
          },
          cleanupPaths: [PACKAGE_MANAGER_CACHE_ROOT],
        }
      : {
          kind: "locked",
          manager: "npm",
          lockfile: dependency.lockfile,
          install: {
            command: "npm",
            arguments: [
              "ci",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "--cache",
              `${PACKAGE_MANAGER_CACHE_ROOT}/npm`,
            ],
          },
          cleanupPaths: [PACKAGE_MANAGER_CACHE_ROOT],
        }
    : { kind: "none" };

  return nodeRuntimePlanSchema.parse({
    planVersion: 1,
    ecosystem: "node",
    runtime: { name: "node", version: "24" },
    baseImage: options.baseImage ?? DEFAULT_NODE_SANDBOX_IMAGE,
    dependencies,
    commands: {
      kind: "package-scripts",
      packageManagers: ["npm", "pnpm"],
      scripts: ["test", "typecheck", "build"],
    },
    network: {
      dependencyInstall: dependencies.kind === "locked",
      execution: false,
    },
  });
}

export function createPythonRuntimePlan(
  options: PythonRuntimePlanOptions = {},
): PythonRuntimePlan {
  const dependency = options.dependency ?? { manager: "uv" as const };
  const capabilities = options.capabilities ?? {};
  const runWithEnvironment = (arguments_: string[]): string[] =>
    dependency.manager === "uv"
      ? ["run", "--offline", "--frozen", "--no-sync", ...arguments_]
      : arguments_;
  const recipes: ExactRuntimeCommand[] = [
    {
      capability: "typecheck",
      command: dependency.manager === "uv" ? "uv" : "python",
      arguments:
        dependency.manager === "uv"
          ? runWithEnvironment(
              capabilities.mypy
                ? ["mypy", "."]
                : ["python", "-m", "compileall", "-q", "."],
            )
          : capabilities.mypy
            ? ["-m", "mypy", "."]
            : ["-m", "compileall", "-q", "."],
    },
  ];
  if (capabilities.pytest) {
    recipes.unshift({
      capability: "test",
      command: dependency.manager === "uv" ? "uv" : "python",
      arguments: runWithEnvironment(
        dependency.manager === "uv" ? ["pytest"] : ["-m", "pytest"],
      ),
    });
  }
  if (capabilities.build) {
    recipes.push({
      capability: "build",
      command: dependency.manager === "uv" ? "uv" : "python",
      arguments:
        dependency.manager === "uv"
          ? ["build", "--offline"]
          : ["-m", "build", "--no-isolation"],
    });
  }

  const dependencies: PythonRuntimePlan["dependencies"] =
    dependency.manager === "uv"
      ? {
          kind: "locked",
          manager: "uv",
          lockfile: "uv.lock",
          install: {
            command: "uv",
            arguments: [
              "sync",
              "--frozen",
              "--no-install-workspace",
              "--no-editable",
              "--no-managed-python",
              "--no-progress",
              "--cache-dir",
              `${PACKAGE_MANAGER_CACHE_ROOT}/uv`,
            ],
          },
          cleanupPaths: [PACKAGE_MANAGER_CACHE_ROOT],
        }
      : {
          kind: "locked",
          manager: "pip",
          lockfile: "requirements.txt",
          hashesRequired: dependency.hashesRequired,
          install: {
            command: "python",
            arguments: [
              "-m",
              "pip",
              "install",
              "--disable-pip-version-check",
              "--no-input",
              "--only-binary=:all:",
              "--no-deps",
              ...(dependency.hashesRequired ? ["--require-hashes"] : []),
              "--target",
              "/workspace/.pathforge-python-packages",
              "--cache-dir",
              `${PACKAGE_MANAGER_CACHE_ROOT}/pip`,
              "-r",
              "requirements.txt",
            ],
          },
          cleanupPaths: [PACKAGE_MANAGER_CACHE_ROOT],
        };

  return pythonRuntimePlanSchema.parse({
    planVersion: 1,
    ecosystem: "python",
    runtime: { name: "python", version: "3.13" },
    baseImage: options.baseImage ?? DEFAULT_PYTHON_SANDBOX_IMAGE,
    dependencies,
    commands: {
      kind: "exact",
      recipes,
    },
    network: { dependencyInstall: true, execution: false },
  });
}
