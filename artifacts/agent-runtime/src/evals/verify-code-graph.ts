import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphCode } from "../code-graph/code-graph";
import { GraphCodeFileTool } from "../tools/graph-code-file-tool";
import { WorkspaceAccess } from "../workspace/workspace-access";

const source = [
  'import { alpha } from "alpha";',
  'import { beta } from "beta";',
  "",
  "function outer() {",
  "  if (ready) {",
  "    run();",
  "  }",
  "}",
  "",
].join("\n");

const graph = graphCode(source, { path: "src/example.ts" });
assert.equal(graph.version, 1);
assert.equal(graph.indentation.unitColumns, 2);
assert.deepEqual(graph.rangeContext, {
  startLine: "previous-line-on-indent-increase",
  endLine: "exact",
});
assert.deepEqual(graph.leadingLinePolicy, {
  markers: ["//", "#", "@", "!"],
  skipBlankLines: true,
  overlapAllowed: true,
});
const indentationNodes = graph.nodes.filter((node) => node.kind === "indentation");
assert.deepEqual(graph.nodes[0]?.range, { startLine: 1, endLine: 8 });
assert.deepEqual(indentationNodes.map((node) => node.depth), [0, 1, 2]);
assert.equal(graph.nodes[2]?.parentId, graph.nodes[1]?.id);
assert.deepEqual(graph.nodes[2]?.range, { startLine: 5, endLine: 7 });
assert.equal("code" in graph.nodes[2]!, false);
assert.deepEqual(graph.nodes[1]?.range, { startLine: 4, endLine: 8 });
assert.deepEqual(
  graph.nodes
    .filter((node) => node.kind === "parent-remainder")
    .map((node) => node.range),
  [
    { startLine: 1, endLine: 2 },
  ],
);
const graphNodesById = new Map(graph.nodes.map((node) => [node.id, node]));
for (const node of graph.nodes) {
  if (!node.parentId) continue;
  const parent = graphNodesById.get(node.parentId)!;
  assert.ok(parent.range.startLine <= node.range.startLine);
  assert.ok(parent.range.endLine >= node.range.endLine);
}
assert.equal("gaps" in graph, false);

const jumped = graphCode("root\n    child\n", { tabWidth: 4 });
assert.equal(jumped.nodes[1]?.indent.columns, 4);
assert.equal(jumped.nodes[1]?.indent.level, 1);
assert.equal(jumped.nodes[1]?.depth, 1);
assert.equal(jumped.diagnostics[0]?.type, undefined);

const mixed = graphCode("root\n \tchild\n", { tabWidth: 4 });
assert.equal(mixed.diagnostics[0]?.type, "mixed_indentation");

const documented = graphCode([
  "/**",
  " * Documentation decoration is not an indentation level.",
  " */",
  "function example() {",
  "  return true;",
  "}",
].join("\n"));
assert.equal(documented.indentation.unitColumns, 2);

const fixture = await mkdtemp(join(tmpdir(), "pathforge-code-graph-"));
try {
  await writeFile(join(fixture, "example.ts"), source, "utf8");
  const tool = new GraphCodeFileTool(new WorkspaceAccess(fixture));
  const result = await tool.execute({
    path: "example.ts",
    tabWidth: 4,
    maxNodes: 100,
  }) as ReturnType<typeof graphCode>;
  assert.equal(result.source.path, "example.ts");
  assert.deepEqual(result.nodes[2]?.range, { startLine: 5, endLine: 7 });
  assert.equal(result.nodes.some((node) => "code" in node), false);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const siblingGraph = graphCode([
  "root",
  "  first",
  "    work",
  "root continuation",
  "  second",
  "    more work",
].join("\n"));
const siblingIndentationNodes = siblingGraph.nodes.filter(
  (node) => node.kind === "indentation",
);
assert.equal(siblingIndentationNodes.length, 5);
assert.equal(
  siblingIndentationNodes[1]?.parentId,
  siblingIndentationNodes[3]?.parentId,
);
assert.notEqual(siblingIndentationNodes[1]?.id, siblingIndentationNodes[3]?.id);

const contextualParent = graphCode([
  "root",
  "  parent",
  "  parent continuation",
  "    child",
].join("\n"));
assert.ok(
  contextualParent.nodes.some(
    (node) =>
      node.kind === "parent-remainder" &&
      node.parentId === "n2" &&
      node.range.startLine === 2 &&
      node.range.endLine === 2,
  ),
);

const exactParent = graphCode([
  "root",
  "root continuation",
  "  child",
].join("\n"));
assert.ok(
  exactParent.nodes.some(
    (node) =>
      node.kind === "parent-remainder" &&
      node.parentId === "n1" &&
      node.range.startLine === 1 &&
      node.range.endLine === 1,
  ),
);

const twelveLineRemainder = graphCode([
  ...Array.from({ length: 13 }, (_, index) => `root line ${index + 1}`),
  "  child",
].join("\n"));
assert.ok(
  twelveLineRemainder.nodes.some(
    (node) =>
      node.kind === "parent-remainder" &&
      node.parentId === "n1" &&
      node.range.startLine === 1 &&
      node.range.endLine === 12,
  ),
);

const blankBeforeChild = graphCode([
  "root",
  "",
  "  child",
].join("\n"));
const blankChild = blankBeforeChild.nodes.find(
  (node) => node.kind === "indentation" && node.parentId === "n1",
)!;
assert.deepEqual(blankChild.range, { startLine: 1, endLine: 3 });
assert.equal(
  blankBeforeChild.nodes.some(
    (node) =>
      node.kind === "parent-remainder" &&
      node.range.startLine === 2 &&
      node.range.endLine === 2,
  ),
  false,
);
assert.equal("gaps" in blankBeforeChild, false);

const balancedExpansion = graphCode([
  "values = [",
  "  first,",
  "  second,",
  "]",
  "print(values)",
].join("\n"));
const valuesChild = balancedExpansion.nodes.find(
  (node) => node.kind === "indentation" && node.parentId === "n1",
)!;
assert.deepEqual(valuesChild.range, { startLine: 1, endLine: 4 });

const excessiveClosingStart = graphCode([
  ")",
  "call(",
  "  value",
  ")",
].join("\n"));
assert.equal(excessiveClosingStart.nodes[0]?.range.startLine, 2);

const quotedBracket = graphCode('print("]")\nnext_call()');
assert.deepEqual(quotedBracket.nodes[0]?.range, { startLine: 1, endLine: 2 });
assert.equal(
  quotedBracket.diagnostics.some(
    (diagnostic) => diagnostic.type === "unbalanced_delimiters",
  ),
  false,
);

const leadingMarkers = graphCode([
  "root",
  "// slash comment",
  "",
  "# hash comment",
  "",
  "@decorator",
  "",
  "!directive",
  "",
  "  child",
].join("\n"));
const markerChild = leadingMarkers.nodes.find(
  (node) => node.kind === "indentation" && node.parentId === "n1",
)!;
assert.deepEqual(markerChild.range, { startLine: 2, endLine: 10 });
assert.ok(
  leadingMarkers.nodes.some(
    (node) =>
      node.kind === "parent-remainder" &&
      node.parentId === "n1" &&
      node.range.startLine === 1 &&
      node.range.endLine === 1,
  ),
);

const commentBeforeFunction = graphCode([
  "# --- XỬ LÝ LOGIC TERMINAL (Background Thread) ---",
  "def go(huong):",
  "    global x, y",
  "    huong = huong.upper()",
  '    if huong == "L":',
  "        y -= 1",
  '        print("Bạn đã đi lên trên")',
  '    elif huong == "T":',
  "        x -= 1",
  '        print("Bạn đã đi qua trái")',
].join("\n"));
const functionBodyNode = commentBeforeFunction.nodes.find(
  (node) => node.kind === "indentation" && node.parentId === "n1",
)!;
assert.equal(functionBodyNode.range.startLine, 1);
assert.equal(
  commentBeforeFunction.nodes.some(
    (node) =>
      node.kind === "parent-remainder" &&
      node.parentId === "n1" &&
      node.range.startLine === 1 &&
      node.range.endLine === 1,
  ),
  false,
);

process.stdout.write("PASS indentation code graph verification\n");
