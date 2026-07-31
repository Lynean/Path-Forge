import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type {
  AgentDecision,
  AgentEvent,
  ModelTurnContext,
  ToolObservation,
} from "../contracts";
import { createNodeRuntimePlan } from "../environment/runtime-plan";
import { RuntimePolicy } from "../environment/runtime-policy";
import type { ModelAdapter } from "../model/model-adapter";
import { AllowlistedCommandPolicy } from "../policy/command-policy";
import { AgentHarness } from "../runtime/harness";
import { DockerSandbox } from "../sandbox/docker-sandbox";
import { SandboxManager } from "../sandbox/sandbox-manager";
import { GraphParentTool } from "../tools/graph-parent-tool";
import { GraphSearchTool } from "../tools/graph-search-tool";
import { ProjectGraphStore } from "../tools/project-graph-store";
import { RunCommandTool } from "../tools/run-command-tool";
import { ToolRegistry } from "../tools/tool";
import { ApplyPatchTool } from "../tools/workspace-edit-tool";
import { ReadFileTool, SearchCodeTool } from "../tools/workspace-tools";
import { WorkspaceAccess } from "../workspace/workspace-access";

type Strategy = "graph_search" | "file_search";

const faultyLine = "  return left - right;";
const repairedLine = "  return left + right;";
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "docker-repair-workspace",
);
const invocationRoot = process.env["INIT_CWD"] ?? process.cwd();

function estimatedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function toolObservation(
  observations: ToolObservation[],
  tool: string,
): ToolObservation | undefined {
  return observations.find((observation) => observation.tool === tool);
}

function finalDecision(response: string): AgentDecision {
  return {
    type: "final",
    response,
    proposedActions: [{
      type: "none",
      reason: "The repair is staged and still requires explicit acceptance.",
    }],
  };
}

class DebugRaceModel implements ModelAdapter {
  constructor(private readonly strategy: Strategy) {}

  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    const commands = context.observations.filter(
      (observation) => observation.tool === "run_command",
    );
    const patch = toolObservation(context.observations, "apply_patch");

    if (commands.length === 0) {
      return {
        type: "tool_call",
        call: {
          id: `${this.strategy}-prove-failure`,
          name: "run_command",
          arguments: {
            command: "pnpm",
            arguments: ["test"],
            workingDirectory: ".",
          },
        },
      };
    }

    if (this.strategy === "graph_search") {
      const retrieval = toolObservation(context.observations, "graph_search");
      if (!retrieval) {
        return {
          type: "tool_call",
          call: {
            id: "graph-locate-add",
            name: "graph_search",
            arguments: { query: "add", maxResults: 5 },
          },
        };
      }
      if (!patch) {
        const result = retrieval.output as {
          matches?: Array<{
            path?: string;
            node_id?: string;
            NodeCode?: string;
          }>;
        };
        const parentObservations = context.observations.filter(
          (observation) => observation.tool === "graph_parent",
        );
        const latestParent = parentObservations.at(-1)?.output as
          | {
              ok?: boolean;
              parent?: {
                path?: string;
                node_id?: string;
                NodeCode?: string;
              } | null;
            }
          | undefined;
        const evidence = [
          ...(result.matches ?? []),
          ...(latestParent?.parent ? [latestParent.parent] : []),
        ];
        const bug = evidence.find(
          (match) =>
            match.path === "src/calculator.js" &&
            match.NodeCode?.includes(faultyLine),
        );
        if (bug) {
          return {
            type: "tool_call",
            call: {
              id: "graph-stage-fix",
              name: "apply_patch",
              arguments: {
                path: bug.path,
                oldText: faultyLine,
                newText: repairedLine,
              },
            },
          };
        }
        const nodeToExpand =
          parentObservations.length === 0
            ? result.matches?.find(
                (match) => match.path === "src/calculator.js",
              )?.node_id
            : latestParent?.parent?.node_id;
        if (nodeToExpand) {
          return {
            type: "tool_call",
            call: {
              id: `graph-expand-${parentObservations.length + 1}`,
              name: "graph_parent",
              arguments: { node_id: nodeToExpand },
            },
          };
        }
        return finalDecision(
          "Graph navigation reached the root without localizing the faulty subtraction.",
        );
      }
    } else {
      const search = toolObservation(context.observations, "search_code");
      const read = toolObservation(context.observations, "read_file");
      if (!search) {
        return {
          type: "tool_call",
          call: {
            id: "file-locate-add",
            name: "search_code",
            arguments: { query: "add", path: ".", maxResults: 30 },
          },
        };
      }
      if (!read) {
        const result = search.output as {
          matches?: Array<{ path?: string; line?: number; text?: string }>;
        };
        const definition = result.matches?.find(
          (match) =>
            match.path?.startsWith("src/") &&
            match.text?.includes("function add"),
        );
        if (!definition?.path || !definition.line) {
          return finalDecision(
            "File search did not identify the source definition to inspect.",
          );
        }
        return {
          type: "tool_call",
          call: {
            id: "file-read-definition",
            name: "read_file",
            arguments: {
              path: definition.path,
              startLine: Math.max(1, definition.line - 2),
              endLine: definition.line + 6,
            },
          },
        };
      }
      if (!patch) {
        const result = read.output as { path?: string; content?: string };
        if (!result.path || !result.content?.includes(faultyLine)) {
          return finalDecision(
            "The focused file read did not contain the faulty subtraction.",
          );
        }
        return {
          type: "tool_call",
          call: {
            id: "file-stage-fix",
            name: "apply_patch",
            arguments: {
              path: result.path,
              oldText: faultyLine,
              newText: repairedLine,
            },
          },
        };
      }
    }

    if (commands.length === 1) {
      return {
        type: "tool_call",
        call: {
          id: `${this.strategy}-verify-fix`,
          name: "run_command",
          arguments: {
            command: "pnpm",
            arguments: ["test"],
            workingDirectory: ".",
          },
        },
      };
    }

    const verification = commands.at(-1)?.output as { exitCode?: number };
    return finalDecision(
      verification.exitCode === 0
        ? "Localized the defect, staged the repair, and verified the same test now passes."
        : "The staged repair did not pass the verification test.",
    );
  }
}

async function runStrategy(strategy: Strategy): Promise<Record<string, unknown>> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `pathforge-${strategy}-race-`));
  const workspaceRoot = join(temporaryRoot, "workspace");
  await cp(fixtureRoot, workspaceRoot, { recursive: true });

  const workspace = new WorkspaceAccess(workspaceRoot);
  const approvedPlan = new RuntimePolicy().requireApproved(createNodeRuntimePlan());
  const sandboxes = new SandboxManager(
    new DockerSandbox({ runtimePlan: approvedPlan }),
    workspaceRoot,
    () => workspace.stagedEdits(),
  );
  const graphStore =
    strategy === "graph_search" ? new ProjectGraphStore(workspace) : undefined;
  const tools = [
    new RunCommandTool({
      policy: new AllowlistedCommandPolicy(),
      sandboxes,
      timeoutMs: 60_000,
    }),
    new ApplyPatchTool(workspace, sandboxes, 1),
    ...(strategy === "graph_search"
      ? [
          new GraphSearchTool(workspace, graphStore!),
          new GraphParentTool(graphStore!),
        ]
      : [new SearchCodeTool(workspace), new ReadFileTool(workspace)]),
  ];
  const harness = new AgentHarness({
    model: new DebugRaceModel(strategy),
    tools: new ToolRegistry(tools),
    budgets: {
      maxModelTurns: 8,
      maxToolCalls: 6,
      maxRunDurationMs: 180_000,
      maxToolDurationMs: 120_000,
    },
  });
  const events: AgentEvent[] = [];
  const started = performance.now();

  try {
    for await (const event of harness.runTurn({
      runId: `debug-race-${strategy}`,
      workspaceId: `debug-race-${strategy}`,
      preferredLanguage: "English",
      currentNode: { id: 1, title: "Debug the failing add function" },
      messages: [],
      userMessage:
        "Run the failing test, locate the defect using your assigned search tool, stage the smallest repair, and rerun the test.",
    })) {
      events.push(event);
    }
    const elapsedMs = performance.now() - started;
    const toolEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_completed" }> =>
        event.type === "tool_completed",
    );
    const commandOutputs = toolEvents
      .filter((event) => event.tool === "run_command")
      .map((event) => event.output as { exitCode?: number });
    const retrievalTools =
      strategy === "graph_search"
        ? new Set(["graph_search", "graph_parent"])
        : new Set(["search_code", "read_file"]);
    const retrievalOutputs = toolEvents
      .filter((event) => retrievalTools.has(event.tool))
      .map((event) => event.output);
    const allObservationTokens = toolEvents.reduce(
      (sum, event) => sum + estimatedTokens(event.output),
      0,
    );
    const retrievalObservationTokens = retrievalOutputs.reduce<number>(
      (sum, output) => sum + estimatedTokens(output),
      0,
    );
    const completed = events.find(
      (event): event is Extract<AgentEvent, { type: "completed" }> =>
        event.type === "completed",
    );
    const hostSource = await readFile(
      join(workspaceRoot, "src", "calculator.js"),
      "utf8",
    );
    const stagedSource = workspace.stagedEdits()[0]?.content ?? "";
    return {
      strategy,
      elapsedMs,
      modelTurns: completed?.result.turns ?? null,
      toolCalls: completed?.result.toolCalls ?? [],
      toolCallCount: completed?.result.toolCalls.length ?? 0,
      retrievalObservationTokens,
      totalToolObservationTokens: allObservationTokens,
      initialTestFailed: commandOutputs[0]?.exitCode !== 0,
      localizationAccurate: retrievalOutputs.some((output) =>
        JSON.stringify(output).includes(faultyLine),
      ),
      patchStaged: stagedSource.includes(repairedLine),
      verificationPassed: commandOutputs.at(-1)?.exitCode === 0,
      hostWorkspaceUnchanged: hostSource.includes(faultyLine),
      completed: completed !== undefined,
      response: completed?.result.response ?? null,
    };
  } finally {
    await sandboxes
      .disposeRun(`debug-race-${strategy}`)
      .catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const fileFirst = process.argv.includes("--file-first");
const firstResult = await runStrategy(fileFirst ? "file_search" : "graph_search");
const secondResult = await runStrategy(fileFirst ? "graph_search" : "file_search");
const graphResult =
  firstResult["strategy"] === "graph_search" ? firstResult : secondResult;
const fileResult =
  firstResult["strategy"] === "file_search" ? firstResult : secondResult;
const report = {
  generatedAt: new Date().toISOString(),
  fixture: {
    faultyFile:
      "artifacts/agent-runtime/src/evals/fixtures/docker-repair-workspace/src/calculator.js",
    testFile:
      "artifacts/agent-runtime/src/evals/fixtures/docker-repair-workspace/test/calculator.test.js",
    defect: "add subtracts right from left instead of adding it",
  },
  methodology: {
    sameModelController: true,
    sameFailingTest: "pnpm test",
    samePatch: `${JSON.stringify(faultyLine)} -> ${JSON.stringify(repairedLine)}`,
    graphFlow:
      "run test -> graph_search(\"add\") -> graph_parent(node_id) until sufficient -> patch -> rerun test",
    fileFlow:
      "run test -> search_code(\"add\") -> focused read_file -> patch -> rerun test",
    tokenEstimate: "sum ceil(serialized tool output characters / 4)",
    execution: "isolated Docker sandbox; edits staged in memory",
    executionOrder: fileFirst
      ? ["file_search", "graph_search"]
      : ["graph_search", "file_search"],
  },
  results: {
    graphSearch: graphResult,
    fileSearch: fileResult,
  },
};
const reportPath = resolve(invocationRoot, "graph/debug-search-race.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const passed = [graphResult, fileResult].every(
  (result) =>
    result["initialTestFailed"] === true &&
    result["localizationAccurate"] === true &&
    result["patchStaged"] === true &&
    result["verificationPassed"] === true &&
    result["hostWorkspaceUnchanged"] === true &&
    result["completed"] === true,
);
if (!passed) process.exitCode = 1;
