# Indentation code graph

This module turns a UTF-8 source file into a deterministic, language-agnostic
JSON graph. It is intended for harness inspection and later debug rendering,
not as a replacement for a language parser.

## Node rule

A node contains a run of code lines with the same leading indentation. Blank
lines are ignored when comparing adjacent code lines, so they neither create a
node nor split an otherwise continuous same-indentation node. The JSON has no
blank-line records, blank-only remainder nodes, or ranges that begin or end on
a blank line. Internal blank lines may still lie inside a contiguous source
range. A node's parent is the nearest preceding node with fewer indentation
columns.

Dedenting directly to an open ancestor resumes that ancestor instead of
creating a sibling. A sibling at that indentation is created only after the
source first returns to the parent's indentation and then indents again.

After containment ranges are calculated, uncovered portions of a non-leaf
parent become `parent-remainder` leaf nodes. These make the parent's own header,
between-child statements, and trailing lines addressable without reading the
entire subtree. Remainders stop immediately before the next child and resume
immediately after the previous child, so sibling ranges do not overlap. If a
parent range includes a preceding line borrowed as indent-increase context, its
remainder begins at the parent's actual first code line and excludes that
borrowed line. If a child covers lines 13-21 of a parent whose actual code
begins at line 1, the leading remainder is exactly 1-12.

The graph records two different measures:

- `indent.columns`: visual columns after expanding tabs.
- `depth`: the number of real code-node ancestors.

For example, four spaces commonly mean `columns: 4` and `depth: 1`. A node only
has four parents when four preceding nested code nodes form that ancestry.
Missing indentation levels are not filled with invented nodes.

Each node retains only its inclusive source line range; source code is
deliberately omitted so an agent can inspect the graph cheaply, select a node,
and call `read_file` with that node's `startLine`/`endLine`. A node's range
covers its own indentation run and the complete ranges of every descendant, so
a parent's range always contains its children. When a line transitions into
deeper indentation, that child range includes the preceding nonblank line that
introduced the block. A dedent starts exactly on its own line and receives no
preceding context. No range receives extra context after its `endLine`.
Overlap between parent and child ranges is intentional. Closing delimiters may
be separate sibling nodes because the algorithm deliberately uses layout rather
than syntax.

## Harness tool

`GraphCodeFileTool` is read-only and uses `WorkspaceAccess`, so it sees staged
content and cannot escape the approved workspace. Its tool name is
`graph_code_file`.

## CLI

```bash
pnpm --filter @workspace/agent-runtime run graph:code -- \
  path/to/input.ts path/to/output.json
```

Optional arguments:

```text
--tab-width N
--max-nodes N
```

The CLI is the explicit artifact-writing boundary. The harness tool itself only
returns the JSON value in memory.

## Whole-project index

Build the protected project index from a project directory:

```bash
pnpm --filter @workspace/agent-runtime run graph:project -- path/to/project
```

This writes `graph/project_graph.json`. Source content is stored once per file;
nodes contain globally unique IDs and ranges rather than duplicate code. The
generated file is excluded from normal agent listing/search, rejected by
`WorkspaceAccess`, excluded from sandbox snapshots, and git-ignored in this
repository.

The normal agent entry point is `graph_search`, not the JSON file. It rebuilds
the index from current workspace content, performs bounded case-insensitive
text ranking internally, and returns at most the requested number of:

```text
path, node_id, range_of_node, parent_node_id, NodeCode
```

The tool caps the combined returned code at 24,000 characters so a very large
index cannot become a correspondingly large model observation.

## Natural next layers

The stable source-layout graph can later be enriched without changing node IDs
or line addresses:

1. Classify nodes as imports, declarations, functions, branches, JSX, comments,
   or closing delimiters.
2. Add AST symbol and reference edges when a parser is available.
3. Collapse import groups or low-value delimiter nodes in the renderer.
4. Render the JSON with expandable nodes, source highlighting, and filters for
   containment versus symbol/reference edges.

## Delimiter normalization

Before delimiter normalization, containment, and remainders are calculated,
each indentation node scans upward past blank lines and attaches consecutive
lines whose trimmed text begins with `//`, `#`, `@`, or `!`. This intentionally
allows overlap with another node so comments, decorators, and directives travel
with the code they describe.

The resulting indentation ranges then expand forward until `()`, `{}`, and `[]`
counts match and unescaped single/double quote counts are even. Brackets inside
single/double quoted strings and common line/block comments are ignored. A
leading line with more closers than openers is removed. Containment and
remainders are calculated only after these starts and ends are final.
Unbalanced remainder candidates are skipped and reported in `diagnostics`; the
containing parent still addresses those lines.
