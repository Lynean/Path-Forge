import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProjectGraph,
  PROJECT_GRAPH_PATH,
  type ProjectGraph,
} from "../code-graph/project-graph";
import {
  GraphParentTool,
  type GraphParentResult,
} from "../tools/graph-parent-tool";
import { GraphSearchTool } from "../tools/graph-search-tool";
import { ProjectGraphStore } from "../tools/project-graph-store";
import { ListFilesTool, SearchCodeTool } from "../tools/workspace-tools";
import { WorkspaceAccess } from "../workspace/workspace-access";

const fixture = await mkdtemp(join(tmpdir(), "pathforge-project-graph-"));
try {
  await mkdir(join(fixture, "src"), { recursive: true });
  await writeFile(
    join(fixture, "src", "main.py"),
    [
      "# Xử lý hướng di chuyển trong terminal",
      "def go(huong):",
      "    global x, y",
      '    if huong == "T":',
      "        x -= 1",
      '        print("Bạn đã đi qua trái")',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(fixture, "src", "status.ts"),
    'export const statusMessage = "ready";\n',
    "utf8",
  );
  const workspace = new WorkspaceAccess(fixture);
  const graph = await buildProjectGraph(fixture, {
    readSource: (path) => workspace.readTextFile(path),
  });
  assert.equal(graph.kind, "project-code-graph");
  assert.equal(graph.files.length, 2);
  assert.ok(graph.totals.nodes > 0);

  const serialized = JSON.parse(
    await readFile(join(fixture, ...PROJECT_GRAPH_PATH.split("/")), "utf8"),
  ) as ProjectGraph;
  assert.equal(serialized.files.length, 2);
  assert.ok(serialized.files.some((file) => file.path === "src/main.py"));
  assert.equal(
    serialized.files.some((file) =>
      file.nodes.some((node) => "code" in node),
    ),
    false,
  );

  const graphStore = new ProjectGraphStore(workspace);
  const searchTool = new GraphSearchTool(workspace, graphStore);
  const parentTool = new GraphParentTool(graphStore);
  const search = await searchTool.execute({
    query: "đi qua trái",
    maxResults: 3,
  }) as {
    matches: Array<{
      path: string;
      node_id: string;
      range_of_node: { startLine: number; endLine: number };
      parent_node_id: string | null;
      NodeCode: string;
    }>;
  };
  assert.ok(search.matches.length > 0);
  assert.equal(search.matches[0]?.path, "src/main.py");
  assert.ok(search.matches[0]?.NodeCode.includes("đi qua trái"));
  assert.ok(search.matches[0]?.node_id);
  assert.ok(search.matches[0]?.range_of_node.startLine);
  const goSearch = await searchTool.execute({
    query: "go",
    maxResults: 10,
  }) as typeof search;
  const nodesById = new Map(
    serialized.files.flatMap((file) =>
      file.nodes.map((node) => [node.id, node] as const),
    ),
  );
  assert.ok(goSearch.matches.length > 0);
  const resultDepths = goSearch.matches.map(
    (match) => nodesById.get(match.node_id)?.depth ?? -1,
  );
  assert.deepEqual(resultDepths, [...resultDepths].sort((left, right) => right - left));
  const returnedIds = new Set(goSearch.matches.map((match) => match.node_id));
  for (const match of goSearch.matches) {
    let parentId = nodesById.get(match.node_id)?.parentId ?? null;
    while (parentId) {
      assert.equal(returnedIds.has(parentId), false);
      parentId = nodesById.get(parentId)?.parentId ?? null;
    }
  }
  const parentResult = await parentTool.execute({
    node_id: search.matches[0]!.node_id,
  });
  assert.equal(parentResult.ok, true);
  assert.equal(
    parentResult.ok ? parentResult.parent?.node_id : null,
    search.matches[0]!.parent_node_id,
  );
  assert.equal(
    parentResult.ok ? parentResult.parent?.path : null,
    search.matches[0]!.path,
  );
  assert.ok(
    parentResult.ok && parentResult.parent?.NodeCode.includes("đi qua trái"),
  );
  assert.equal(
    parentResult.ok ? parentResult.parent?.NodeCodeTruncated : null,
    false,
  );
  if (parentResult.ok && parentResult.parent?.parent_node_id) {
    const grandparentResult = await parentTool.execute({
      node_id: parentResult.parent.node_id,
    });
    assert.equal(grandparentResult.ok, true);
    assert.equal(
      grandparentResult.ok ? grandparentResult.parent?.node_id : null,
      parentResult.parent.parent_node_id,
    );
  }

  const mainFile = serialized.files.find((file) => file.path === "src/main.py")!;
  const rootResult = await parentTool.execute({
    node_id: mainFile.rootIds[0]!,
  });
  assert.deepEqual(rootResult, {
    ok: true,
    node_id: mainFile.rootIds[0]!,
    parent: null,
  } satisfies GraphParentResult);

  const missingResult = await parentTool.execute({
    node_id: "missing-node",
  });
  assert.equal(missingResult.ok, false);
  assert.equal(
    missingResult.ok ? null : missingResult.error,
    "GRAPH_NODE_NOT_FOUND",
  );

  const boundedParent = await new GraphParentTool(graphStore, 10).execute({
    node_id: search.matches[0]!.node_id,
  });
  assert.equal(
    boundedParent.ok ? boundedParent.parent?.NodeCode.length : null,
    10,
  );
  assert.equal(
    boundedParent.ok ? boundedParent.parent?.NodeCodeTruncated : null,
    true,
  );

  await assert.rejects(
    workspace.readTextFile(PROJECT_GRAPH_PATH),
    /protected from agent access/,
  );
  const listed = await new ListFilesTool(workspace).execute({
    path: ".",
    depth: 3,
  }) as { entries: Array<{ path: string }> };
  assert.equal(
    listed.entries.some((entry) => entry.path.startsWith("graph")),
    false,
  );
  const searched = await new SearchCodeTool(workspace).execute({
    query: "project-code-graph",
    path: ".",
    maxResults: 10,
  }) as { matches: unknown[] };
  assert.equal(searched.matches.length, 0);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

process.stdout.write("PASS protected project graph and bounded graph search\n");
