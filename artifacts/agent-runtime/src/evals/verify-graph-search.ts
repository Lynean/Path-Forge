import assert from "node:assert/strict";
import type { CodeGraphNode } from "../code-graph/code-graph";
import type {
  ProjectGraph,
  ProjectGraphFile,
} from "../code-graph/project-graph";
import { searchProjectGraph } from "../tools/graph-search-tool";

function node(
  id: string,
  parentId: string | null,
  childIds: string[],
  depth: number,
  startLine: number,
  endLine: number,
): CodeGraphNode {
  return {
    id,
    kind: "indentation",
    parentId,
    childIds,
    depth,
    indent: { raw: "  ".repeat(depth), columns: depth * 2, level: depth },
    range: { startLine, endLine },
  };
}

function file(
  path: string,
  content: string,
  nodes: CodeGraphNode[],
): ProjectGraphFile {
  return {
    path,
    sha256: path,
    lineCount: content.split("\n").length,
    content,
    rootIds: nodes.filter((candidate) => candidate.parentId === null).map(({ id }) => id),
    nodes,
    diagnostics: [],
  };
}

const graphFiles = [
  file(
    "src/main.ts",
    [
      "function go() {",
      '  const label = "GO";',
      "  if (ready) {",
      '    console.log("go");',
      "  }",
      "}",
      "const anchor = true;",
      "  use(anchorValue);",
    ].join("\n"),
    [
      node("main-root", null, ["main-declaration", "main-if"], 0, 1, 6),
      node("main-declaration", "main-root", [], 1, 1, 2),
      node("main-if", "main-root", ["main-log"], 1, 3, 5),
      node("main-log", "main-if", [], 2, 3, 4),
      node("anchor-root", null, ["anchor-child"], 0, 7, 8),
      node("anchor-child", "anchor-root", [], 1, 8, 8),
    ],
  ),
  file(
    "src/other.py",
    ['def go():', '    print("go")'].join("\n"),
    [
      node("other-root", null, ["other-leaf"], 0, 1, 2),
      node("other-leaf", "other-root", [], 1, 1, 2),
    ],
  ),
  file(
    "tests/main.test.ts",
    'expect(run()).toBe("go");',
    [node("test-root", null, [], 0, 1, 1)],
  ),
  file(
    "src/duplicate.ts",
    'const duplicate = "go";',
    [
      node("duplicate-parent", null, ["duplicate-child"], 0, 1, 1),
      node("duplicate-child", "duplicate-parent", [], 1, 1, 1),
    ],
  ),
] satisfies ProjectGraphFile[];

const graph: ProjectGraph = {
  version: 1,
  kind: "project-code-graph",
  generatedAt: "2026-07-30T00:00:00.000Z",
  files: graphFiles,
  skippedFiles: [],
  totals: {
    files: graphFiles.length,
    nodes: graphFiles.reduce((sum, entry) => sum + entry.nodes.length, 0),
    sourceCharacters: graphFiles.reduce((sum, entry) => sum + entry.content.length, 0),
  },
};

const go = searchProjectGraph(graph, "go", { maxResults: 10 });
assert.deepEqual(
  go.matches.map(({ node_id }) => node_id),
  [
    "main-log",
    "other-leaf",
    "main-declaration",
    "duplicate-child",
    "test-root",
  ],
);
assert.equal(go.matches.some(({ node_id }) => node_id === "main-root"), false);
assert.equal(go.matches.some(({ node_id }) => node_id === "main-if"), false);
assert.equal(go.matches.some(({ node_id }) => node_id === "duplicate-parent"), false);
assert.equal(go.truncated, false);

const caseInsensitive = searchProjectGraph(graph, "GO", { maxResults: 10 });
assert.deepEqual(
  caseInsensitive.matches.map(({ node_id }) => node_id),
  go.matches.map(({ node_id }) => node_id),
);

const exactPhrase = searchProjectGraph(graph, "function go", { maxResults: 10 });
assert.deepEqual(
  exactPhrase.matches.map(({ node_id }) => node_id),
  ["main-declaration"],
);
assert.equal(
  searchProjectGraph(graph, "function missing", { maxResults: 10 }).matches.length,
  0,
);

const unmatchedChild = searchProjectGraph(graph, "const anchor", { maxResults: 10 });
assert.deepEqual(
  unmatchedChild.matches.map(({ node_id }) => node_id),
  ["anchor-root"],
);

const pathFiltered = searchProjectGraph(graph, "go", {
  path: "other.py",
  maxResults: 10,
});
assert.deepEqual(
  pathFiltered.matches.map(({ node_id }) => node_id),
  ["other-leaf"],
);

const resultLimited = searchProjectGraph(graph, "go", { maxResults: 2 });
assert.equal(resultLimited.matches.length, 2);
assert.equal(resultLimited.truncated, true);

const characterLimited = searchProjectGraph(graph, "go", {
  maxResults: 10,
  maxTotalCharacters: 10,
});
assert.ok(characterLimited.matches.length < go.matches.length);
assert.equal(characterLimited.truncated, true);
assert.ok(
  characterLimited.matches.reduce(
    (sum, match) => sum + match.NodeCode.length,
    0,
  ) <= 10,
);

process.stdout.write("PASS literal youngest-node graph search edge cases\n");
