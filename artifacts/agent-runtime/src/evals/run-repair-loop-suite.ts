import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AgentDecision, ModelTurnContext } from "../contracts";
import { createNodeRuntimePlan } from "../environment/runtime-plan";
import { RuntimePolicy } from "../environment/runtime-policy";
import type { ModelAdapter } from "../model/model-adapter";
import { AllowlistedCommandPolicy } from "../policy/command-policy";
import { AgentHarness } from "../runtime/harness";
import { DockerSandbox } from "../sandbox/docker-sandbox";
import { SandboxManager } from "../sandbox/sandbox-manager";
import { RunCommandTool } from "../tools/run-command-tool";
import { ToolRegistry } from "../tools/tool";
import { ApplyPatchTool } from "../tools/workspace-edit-tool";
import { ReadFileTool } from "../tools/workspace-tools";
import { WorkspaceAccess } from "../workspace/workspace-access";

const execFileAsync = promisify(execFile);
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "docker-repair-workspace",
);
const temporaryRoot = await mkdtemp(join(tmpdir(), "pathforge-repair-loop-eval-"));
const workspaceRoot = join(temporaryRoot, "workspace");
await cp(fixtureRoot, workspaceRoot, { recursive: true });

class RepairModel implements ModelAdapter {
  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    switch (context.observations.length) {
      case 0:
        return {
          type: "tool_call",
          call: {
            id: "inspect-bug",
            name: "read_file",
            arguments: { path: "src/calculator.js" },
          },
        };
      case 1:
        return {
          type: "tool_call",
          call: {
            id: "prove-failure",
            name: "run_command",
            arguments: { command: "pnpm", arguments: ["test"], workingDirectory: "." },
          },
        };
      case 2:
        return {
          type: "tool_call",
          call: {
            id: "stage-fix",
            name: "apply_patch",
            arguments: {
              path: "src/calculator.js",
              oldText: "  return left - right;",
              newText: "  return left + right;",
            },
          },
        };
      case 3:
        return {
          type: "tool_call",
          call: {
            id: "verify-fix",
            name: "run_command",
            arguments: { command: "pnpm", arguments: ["test"], workingDirectory: "." },
          },
        };
      default: {
        const verification = context.observations.at(-1)?.output as
          | { exitCode?: number }
          | undefined;
        return {
          type: "final",
          response:
            verification?.exitCode === 0
              ? "The original test failed, the exact fix was staged, and the same test now passes in a fresh Docker sandbox."
              : "The repair could not be verified within its budget.",
          proposedActions: [
            {
              type: "none",
              reason: "The staged diff still requires explicit user approval before any host write.",
            },
          ],
        };
      }
    }
  }
}

const workspace = new WorkspaceAccess(workspaceRoot);
const approvedPlan = new RuntimePolicy().requireApproved(createNodeRuntimePlan());
const sandbox = new DockerSandbox({ runtimePlan: approvedPlan });
const sandboxes = new SandboxManager(
  sandbox,
  workspaceRoot,
  () => workspace.stagedEdits(),
);
const patchTool = new ApplyPatchTool(workspace, sandboxes, 2);
const harness = new AgentHarness({
  model: new RepairModel(),
  tools: new ToolRegistry([
    new ReadFileTool(workspace),
    new RunCommandTool({
      policy: new AllowlistedCommandPolicy(),
      sandboxes,
      timeoutMs: 60_000,
    }),
    patchTool,
  ]),
  budgets: {
    maxModelTurns: 6,
    maxToolCalls: 5,
    maxRunDurationMs: 180_000,
    maxToolDurationMs: 120_000,
  },
});

let failures = 0;
try {
  const events = [];
  for await (const event of harness.runTurn({
    runId: "repair-loop-success",
    workspaceId: "repair-fixture",
    preferredLanguage: "English",
    currentNode: { id: 1, title: "Repair the failing test" },
    messages: [],
    userMessage: "Inspect the bug, run the test, stage a fix, and verify it.",
  })) {
    events.push(event);
  }

  const commandOutputs = events.flatMap((event) =>
    event.type === "tool_completed" && event.tool === "run_command"
      ? [event.output as { exitCode?: number }]
      : [],
  );
  const patchOutput = events.find(
    (event) => event.type === "tool_completed" && event.tool === "apply_patch",
  );
  const completed = events.find((event) => event.type === "completed");
  const hostSource = await readFile(join(workspaceRoot, "src", "calculator.js"), "utf8");
  const remainingContainers = (
    await execFileAsync("docker", [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      "name=pathforge-agent-repair-loop-success",
    ])
  ).stdout.trim();

  if (
    commandOutputs.length === 2 &&
    commandOutputs[0]?.exitCode !== 0 &&
    commandOutputs[1]?.exitCode === 0 &&
    patchOutput?.type === "tool_completed" &&
    (patchOutput.output as { staged?: boolean }).staged === true &&
    workspace.stagedEdits()[0]?.content.includes("left + right") &&
    hostSource.includes("left - right") &&
    completed?.type === "completed" &&
    completed.result.toolCalls.join(",") ===
      "read_file,run_command,apply_patch,run_command" &&
    remainingContainers === ""
  ) {
    console.log(
      "PASS failing test → diagnosis → staged patch → identical passing retest",
    );
  } else {
    failures += 1;
    console.error("FAIL bounded repair loop", JSON.stringify(events, null, 2));
  }

  const budgetWorkspace = new WorkspaceAccess(workspaceRoot);
  const budgetTool = new ApplyPatchTool(budgetWorkspace, undefined, 1);
  const budgetContext = {
    runId: "repair-budget-eval",
    signal: new AbortController().signal,
  };
  await budgetTool.execute(
    {
      path: "src/calculator.js",
      oldText: "  return left - right;",
      newText: "  return left + right;",
    },
    budgetContext,
  );
  const blocked = (await budgetTool.execute(
    {
      path: "test/calculator.test.js",
      oldText: "  assert.equal(add(20, 22), 42);",
      newText: "  assert.equal(add(20, 22), -2);",
    },
    budgetContext,
  )) as { error?: string };
  if (
    blocked.error === "REPAIR_BUDGET_EXCEEDED" &&
    budgetWorkspace.stagedEdits().length === 1
  ) {
    console.log("PASS repair-attempt budget blocks additional staged patches");
  } else {
    failures += 1;
    console.error("FAIL repair-attempt budget");
  }
  await budgetTool.finishRun(budgetContext.runId);
} finally {
  await sandboxes.disposeRun("repair-loop-success").catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("\nAll 2 repair-loop evals passed.");
}

