import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  buildProjectGraph,
  PROJECT_GRAPH_PATH,
  type ProjectGraph,
} from "../code-graph/project-graph";
import { searchProjectGraph } from "../tools/graph-search-tool";
import { ReadFileTool, SearchCodeTool } from "../tools/workspace-tools";
import { WorkspaceAccess } from "../workspace/workspace-access";

interface BenchmarkCase {
  name: string;
  naturalQuery: string;
  literalQuery: string;
  expectedPath: string;
  targetPattern: string;
}

const cases: BenchmarkCase[] = [
  {
    name: "protected graph search",
    naturalQuery: "protected whole project graph search returns bounded matching node code",
    literalQuery: "class GraphSearchTool",
    expectedPath: "artifacts/agent-runtime/src/tools/graph-search-tool.ts",
    targetPattern: "export class GraphSearchTool",
  },
  {
    name: "leading marker attachment",
    naturalQuery: "attach comment decorator and directive lines above an indentation node",
    literalQuery: "startsWithLeadingMarker",
    expectedPath: "artifacts/agent-runtime/src/code-graph/code-graph.ts",
    targetPattern: "function startsWithLeadingMarker",
  },
  {
    name: "sandbox graph exclusion",
    naturalQuery: "exclude generated graph and dependency folders from Docker workspace snapshots",
    literalQuery: "EXCLUDED_DIRECTORIES",
    expectedPath: "artifacts/agent-runtime/src/sandbox/docker-sandbox.ts",
    targetPattern: "const EXCLUDED_DIRECTORIES",
  },
  {
    name: "read inspection limit",
    naturalQuery: "stop source file reads after the inspection read budget is exhausted",
    literalQuery: "READ_FILE_LIMIT_REACHED",
    expectedPath: "artifacts/agent-runtime/src/tools/workspace-tools.ts",
    targetPattern: 'error: "READ_FILE_LIMIT_REACHED"',
  },
  {
    name: "dynamic Clerk key",
    naturalQuery: "derive the Clerk publishable key dynamically from the browser host",
    literalQuery: "publishableKeyFromHost",
    expectedPath: "artifacts/app/src/App.tsx",
    targetPattern: "const clerkPubKey = publishableKeyFromHost",
  },
  {
    name: "extra node SSE event",
    naturalQuery: "stream a server sent event when an extra learning node is spawned",
    literalQuery: "extra_node_spawned",
    expectedPath: "artifacts/api-server/src/routes/nodeMap.ts",
    targetPattern: 'type: "extra_node_spawned"',
  },
];

const BENCHMARK_ARTIFACT_PATHS = new Set([
  "artifacts/agent-runtime/src/evals/benchmark-retrieval.ts",
  "artifacts/agent-runtime/examples/retrieval-benchmark.json",
]);

function estimatedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const invocationRoot = process.env["INIT_CWD"] ?? process.cwd();
const workspaceRoot = resolve(invocationRoot);
const workspace = new WorkspaceAccess(workspaceRoot);
const targets = new Map<string, number>();
for (const benchmarkCase of cases) {
  const content = await readFile(
    resolve(workspaceRoot, ...benchmarkCase.expectedPath.split("/")),
    "utf8",
  );
  const line = content
    .split(/\r\n|\n|\r/)
    .findIndex((candidate) => candidate.includes(benchmarkCase.targetPattern));
  if (line < 0) {
    throw new Error(
      `Benchmark target not found: ${benchmarkCase.expectedPath} :: ${benchmarkCase.targetPattern}`,
    );
  }
  targets.set(benchmarkCase.name, line + 1);
}

const coldBuildStarted = performance.now();
await buildProjectGraph(workspaceRoot, {
  readSource: (path) => workspace.readTextFile(path),
});
const coldBuildMs = performance.now() - coldBuildStarted;

const loadStarted = performance.now();
const graph = JSON.parse(
  await readFile(resolve(workspaceRoot, ...PROJECT_GRAPH_PATH.split("/")), "utf8"),
) as ProjectGraph;
const loadAndParseMs = performance.now() - loadStarted;
const searchableGraph: ProjectGraph = {
  ...graph,
  files: graph.files.filter((file) => !BENCHMARK_ARTIFACT_PATHS.has(file.path)),
  totals: {
    ...graph.totals,
    files: graph.files.filter((file) => !BENCHMARK_ARTIFACT_PATHS.has(file.path)).length,
    nodes: graph.files
      .filter((file) => !BENCHMARK_ARTIFACT_PATHS.has(file.path))
      .reduce((sum, file) => sum + file.nodes.length, 0),
  },
};

const results = [];
for (const benchmarkCase of cases) {
  const targetLine = targets.get(benchmarkCase.name)!;

  const graphStarted = performance.now();
  const graphResult = searchProjectGraph(searchableGraph, benchmarkCase.literalQuery, {
    maxResults: 5,
  });
  const graphMs = performance.now() - graphStarted;
  const graphHits = graphResult.matches.map(
    (match) =>
      match.path === benchmarkCase.expectedPath &&
      match.range_of_node.startLine <= targetLine &&
      match.range_of_node.endLine >= targetLine,
  );

  const fileStarted = performance.now();
  const searchResult = await new SearchCodeTool(workspace).execute({
    query: benchmarkCase.literalQuery,
    path: ".",
    maxResults: 100,
  }) as {
    matches: Array<{ path: string; line: number; text: string }>;
    truncated: boolean;
  };
  const eligibleHits = searchResult.matches.filter(
    (hit) => !BENCHMARK_ARTIFACT_PATHS.has(hit.path),
  );
  const targetRank = eligibleHits.findIndex(
    (hit) =>
      hit.path === benchmarkCase.expectedPath &&
      hit.line - 40 <= targetLine &&
      hit.line + 40 >= targetLine,
  );
  const selectedHits =
    targetRank >= 0 && targetRank < 30
      ? [eligibleHits[targetRank]!]
      : eligibleHits.slice(0, 1);
  const reads = [];
  for (const hit of selectedHits) {
    reads.push(
      await new ReadFileTool(workspace, 100_000).execute({
        path: hit.path,
        startLine: Math.max(1, hit.line - 40),
        endLine: hit.line + 40,
      }),
    );
  }
  const fileMs = performance.now() - fileStarted;
  const fileObservation = {
    search: { matches: eligibleHits.slice(0, 30), truncated: eligibleHits.length > 30 },
    reads,
  };

  results.push({
    name: benchmarkCase.name,
    target: { path: benchmarkCase.expectedPath, line: targetLine },
    graphSearch: {
      query: benchmarkCase.literalQuery,
      milliseconds: graphMs,
      estimatedObservationTokens: estimatedTokens(graphResult),
      top1Correct: graphHits[0] ?? false,
      top5Correct: graphHits.some(Boolean),
      returnedResults: graphResult.matches.length,
      hits: graphResult.matches.map((match) => ({
        path: match.path,
        range: match.range_of_node,
      })),
    },
    fileSearch: {
      query: benchmarkCase.literalQuery,
      milliseconds: fileMs,
      estimatedObservationTokens: estimatedTokens(fileObservation),
      success: targetRank >= 0 && targetRank < 30,
      targetRank: targetRank >= 0 ? targetRank + 1 : null,
      returnedResults: selectedHits.length,
      hits: selectedHits.map((hit) => ({
        path: hit.path,
        line: hit.line,
      })),
    },
  });
}

const graphTimes = results.map((result) => result.graphSearch.milliseconds);
const fileTimes = results.map((result) => result.fileSearch.milliseconds);
const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    tokenEstimate: "ceil(serialized observation characters / 4)",
    graphSearch: "literal query, youngest matching graph nodes first, top 5 results",
    fileSearch: "oracle literal query, inspect up to 30 search_code hits, then read one ±40-line window",
    benchmarkArtifactsExcludedFromRetrieval: [...BENCHMARK_ARTIFACT_PATHS],
    coldGraphBuildReportedSeparately: true,
  },
  project: {
    files: graph.totals.files,
    nodes: graph.totals.nodes,
    graphCharacters: JSON.stringify(graph).length,
  },
  coldGraphBuildMs: coldBuildMs,
  graphLoadAndParseMs: loadAndParseMs,
  aggregate: {
    graphSearch: {
      averageMs: graphTimes.reduce((sum, value) => sum + value, 0) / results.length,
      p50Ms: percentile(graphTimes, 0.5),
      p95Ms: percentile(graphTimes, 0.95),
      averageEstimatedObservationTokens:
        results.reduce(
          (sum, result) => sum + result.graphSearch.estimatedObservationTokens,
          0,
        ) / results.length,
      top1Accuracy:
        results.filter((result) => result.graphSearch.top1Correct).length /
        results.length,
      top5Accuracy:
        results.filter((result) => result.graphSearch.top5Correct).length /
        results.length,
    },
    fileSearch: {
      averageMs: fileTimes.reduce((sum, value) => sum + value, 0) / results.length,
      p50Ms: percentile(fileTimes, 0.5),
      p95Ms: percentile(fileTimes, 0.95),
      averageEstimatedObservationTokens:
        results.reduce(
          (sum, result) => sum + result.fileSearch.estimatedObservationTokens,
          0,
        ) / results.length,
      successRate:
        results.filter((result) => result.fileSearch.success).length /
        results.length,
    },
  },
  cases: results,
};

const outputPath = resolve(
  workspaceRoot,
  "graph/retrieval-benchmark.json",
);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
