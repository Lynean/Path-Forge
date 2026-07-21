import {
  DEFAULT_NODE_SANDBOX_IMAGE,
  DEFAULT_PYTHON_SANDBOX_IMAGE,
  PACKAGE_MANAGER_CACHE_ROOT,
  createNodeRuntimePlan,
  createPythonRuntimePlan,
  runtimePlanSchema,
  type ApprovedRuntimePlan,
  type NodeRuntimePlan,
  type PythonRuntimePlan,
  type RuntimePlan,
} from "./runtime-plan";

export type RuntimePolicyDecision =
  | { allowed: true; approvedPlan: ApprovedRuntimePlan }
  | { allowed: false; code: "RUNTIME_PLAN_REJECTED"; reason: string };

export interface RuntimePolicyOptions {
  trustedBaseImages?: string[];
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedNodePlan(plan: NodeRuntimePlan): NodeRuntimePlan | null {
  if (
    !sameValues(plan.commands.packageManagers, ["npm", "pnpm"]) ||
    !sameValues(plan.commands.scripts, ["test", "typecheck", "build"])
  ) {
    return null;
  }
  if (plan.dependencies.kind === "none") {
    return createNodeRuntimePlan({ baseImage: plan.baseImage });
  }
  if (plan.dependencies.manager === "pnpm") {
    if (plan.dependencies.lockfile !== "pnpm-lock.yaml") return null;
    return createNodeRuntimePlan({
      baseImage: plan.baseImage,
      dependency: { manager: "pnpm", lockfile: "pnpm-lock.yaml" },
    });
  }
  if (plan.dependencies.lockfile === "pnpm-lock.yaml") return null;
  return createNodeRuntimePlan({
    baseImage: plan.baseImage,
    dependency: { manager: "npm", lockfile: plan.dependencies.lockfile },
  });
}

function expectedPythonPlan(plan: PythonRuntimePlan): PythonRuntimePlan {
  const testRecipe = plan.commands.recipes.find((recipe) => recipe.capability === "test");
  const typecheckRecipe = plan.commands.recipes.find(
    (recipe) => recipe.capability === "typecheck",
  );
  const buildRecipe = plan.commands.recipes.find((recipe) => recipe.capability === "build");
  const usesMypy = typecheckRecipe?.arguments.includes("mypy") ?? false;
  return createPythonRuntimePlan({
    baseImage: plan.baseImage,
    dependency:
      plan.dependencies.manager === "uv"
        ? { manager: "uv" }
        : { manager: "pip", hashesRequired: plan.dependencies.hashesRequired },
    capabilities: {
      pytest: Boolean(testRecipe),
      mypy: usesMypy,
      build: Boolean(buildRecipe),
    },
  });
}

/** Validates a deterministic runtime recipe without model judgment or regex command parsing. */
export class RuntimePolicy {
  private readonly trustedBaseImages: Set<string>;

  constructor(options: RuntimePolicyOptions = {}) {
    this.trustedBaseImages = new Set(
      options.trustedBaseImages ?? [
        DEFAULT_NODE_SANDBOX_IMAGE,
        DEFAULT_PYTHON_SANDBOX_IMAGE,
      ],
    );
  }

  evaluate(candidate: RuntimePlan): RuntimePolicyDecision {
    const parsed = runtimePlanSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        allowed: false,
        code: "RUNTIME_PLAN_REJECTED",
        reason: "The runtime plan does not match a supported plan schema.",
      };
    }
    const plan = parsed.data;
    if (!this.trustedBaseImages.has(plan.baseImage)) {
      return {
        allowed: false,
        code: "RUNTIME_PLAN_REJECTED",
        reason: `The base image is not trusted: ${plan.baseImage}`,
      };
    }

    const expected =
      plan.ecosystem === "node"
        ? expectedNodePlan(plan)
        : expectedPythonPlan(plan);
    if (!expected || JSON.stringify(plan) !== JSON.stringify(expected)) {
      return {
        allowed: false,
        code: "RUNTIME_PLAN_REJECTED",
        reason: `The runtime plan contains unreviewed install, command, or network behavior. Temporary files must remain under ${PACKAGE_MANAGER_CACHE_ROOT}.`,
      };
    }
    return {
      allowed: true,
      approvedPlan: { approvedBy: "pathforge-runtime-policy-v1", plan },
    };
  }

  requireApproved(candidate: RuntimePlan): ApprovedRuntimePlan {
    const decision = this.evaluate(candidate);
    if (!decision.allowed) throw new Error(decision.reason);
    return decision.approvedPlan;
  }
}
