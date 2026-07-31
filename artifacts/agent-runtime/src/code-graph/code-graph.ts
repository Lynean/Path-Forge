import { createHash } from "node:crypto";

export interface CodeGraphOptions {
  path?: string;
  tabWidth?: number;
  maxNodes?: number;
}

export interface CodeGraphNode {
  id: string;
  kind: "indentation" | "parent-remainder";
  parentId: string | null;
  childIds: string[];
  depth: number;
  indent: {
    raw: string;
    columns: number;
    level: number | null;
  };
  range: {
    startLine: number;
    endLine: number;
  };
}

export interface CodeGraphDiagnostic {
  type:
    | "indentation_jump"
    | "mixed_indentation"
    | "unbalanced_delimiters"
    | "unbalanced_remainder_skipped";
  line: number;
  message: string;
}

export interface CodeGraph {
  version: 1;
  kind: "indentation-code-graph";
  source: {
    path: string | null;
    sha256: string;
    lineCount: number;
    newline: "lf" | "crlf" | "mixed" | "none";
    hasFinalNewline: boolean;
  };
  indentation: {
    unitColumns: number;
    tabWidth: number;
  };
  rangeContext: {
    startLine: "previous-line-on-indent-increase";
    endLine: "exact";
  };
  delimiterPolicy: {
    pairs: readonly ["()", "{}", "[]"];
    quotes: "even-unescaped-single-and-double";
    leadingExcessClosing: "trim";
    unbalancedRemainders: "skip";
  };
  leadingLinePolicy: {
    markers: readonly ["//", "#", "@", "!"];
    skipBlankLines: true;
    overlapAllowed: true;
  };
  rootIds: string[];
  nodes: CodeGraphNode[];
  diagnostics: CodeGraphDiagnostic[];
}

interface SourceLine {
  number: number;
  text: string;
  indentRaw: string;
  indentColumns: number;
  content: string;
}

const DEFAULT_TAB_WIDTH = 4;
const DEFAULT_MAX_NODES = 2_000;

interface DelimiterCounts {
  parenthesesOpen: number;
  parenthesesClose: number;
  bracesOpen: number;
  bracesClose: number;
  bracketsOpen: number;
  bracketsClose: number;
  doubleQuotes: number;
  singleQuotes: number;
}

function scanDelimiters(
  lines: string[],
  startLine: number,
  endLine: number,
): DelimiterCounts {
  const counts: DelimiterCounts = {
    parenthesesOpen: 0,
    parenthesesClose: 0,
    bracesOpen: 0,
    bracesClose: 0,
    bracketsOpen: 0,
    bracketsClose: 0,
    doubleQuotes: 0,
    singleQuotes: 0,
  };
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let blockComment = false;

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? "";
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      const next = line[index + 1];
      if (blockComment) {
        if (character === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === "\\") {
          escaped = true;
          continue;
        }
        if (character === quote) {
          if (quote === '"') counts.doubleQuotes += 1;
          else counts.singleQuotes += 1;
          quote = null;
        }
        continue;
      }
      if (character === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (
        (character === "/" && next === "/") ||
        character === "#"
      ) {
        break;
      }
      if (character === '"' || character === "'") {
        quote = character;
        if (quote === '"') counts.doubleQuotes += 1;
        else counts.singleQuotes += 1;
        escaped = false;
        continue;
      }
      if (character === "(") counts.parenthesesOpen += 1;
      else if (character === ")") counts.parenthesesClose += 1;
      else if (character === "{") counts.bracesOpen += 1;
      else if (character === "}") counts.bracesClose += 1;
      else if (character === "[") counts.bracketsOpen += 1;
      else if (character === "]") counts.bracketsClose += 1;
    }
    escaped = false;
  }
  return counts;
}

function delimitersBalanced(counts: DelimiterCounts): boolean {
  return (
    counts.parenthesesOpen === counts.parenthesesClose &&
    counts.bracesOpen === counts.bracesClose &&
    counts.bracketsOpen === counts.bracketsClose &&
    counts.doubleQuotes % 2 === 0 &&
    counts.singleQuotes % 2 === 0
  );
}

function firstLineHasExcessClosing(line: string): boolean {
  const counts = scanDelimiters([line], 1, 1);
  return (
    counts.parenthesesClose > counts.parenthesesOpen ||
    counts.bracesClose > counts.bracesOpen ||
    counts.bracketsClose > counts.bracketsOpen
  );
}

function startsWithLeadingMarker(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("@") ||
    trimmed.startsWith("!")
  );
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function indentationColumns(raw: string, tabWidth: number): number {
  let columns = 0;
  for (const character of raw) {
    if (character === "\t") {
      columns += tabWidth - (columns % tabWidth);
    } else {
      columns += 1;
    }
  }
  return columns;
}

function inferIndentationUnit(lines: SourceLine[]): number {
  const structuralLines = lines.filter(
    (line) => !/^(?:\*|\*\/)/.test(line.content),
  );
  const increases = new Map<number, number>();
  for (let index = 1; index < structuralLines.length; index += 1) {
    const previous = structuralLines[index - 1]!;
    const current = structuralLines[index]!;
    const difference = current.indentColumns - previous.indentColumns;
    if (difference > 0) {
      increases.set(difference, (increases.get(difference) ?? 0) + 1);
    }
  }
  const mostCommonIncrease = [...increases.entries()].sort(
    ([leftColumns, leftCount], [rightColumns, rightCount]) =>
      rightCount - leftCount || leftColumns - rightColumns,
  )[0]?.[0];
  if (mostCommonIncrease !== undefined) return mostCommonIncrease;

  const positiveColumns = [
    ...new Set(
      structuralLines
        .map((line) => line.indentColumns)
        .filter((columns) => columns > 0),
    ),
  ];
  if (positiveColumns.length === 0) return 1;
  return positiveColumns.reduce(greatestCommonDivisor);
}

function newlineStyle(source: string): CodeGraph["source"]["newline"] {
  const crlfCount = source.match(/\r\n/g)?.length ?? 0;
  const lfCount = (source.match(/(?<!\r)\n/g)?.length ?? 0);
  if (crlfCount > 0 && lfCount > 0) return "mixed";
  if (crlfCount > 0) return "crlf";
  if (lfCount > 0) return "lf";
  return "none";
}

/**
 * Builds a language-agnostic containment graph from leading whitespace.
 *
 * A node is a run of code lines with the same indentation; intervening blank
 * lines are ignored and included in the node's address range. Its parent is
 * the nearest preceding node with a smaller indentation. This is intentionally
 * a source-layout graph, not an AST: it remains useful for unsupported
 * languages and syntactically incomplete files.
 */
export function graphCode(source: string, options: CodeGraphOptions = {}): CodeGraph {
  const tabWidth = options.tabWidth ?? DEFAULT_TAB_WIDTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isInteger(tabWidth) || tabWidth < 1 || tabWidth > 16) {
    throw new Error("tabWidth must be an integer between 1 and 16");
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new Error("maxNodes must be a positive integer");
  }

  const rawLines = source.split(/\r\n|\n|\r/);
  const sourceLines: SourceLine[] = rawLines.flatMap((text, index) => {
    if (text.trim().length === 0) return [];
    const indentRaw = text.match(/^[\t ]*/)?.[0] ?? "";
    return [{
      number: index + 1,
      text,
      indentRaw,
      indentColumns: indentationColumns(indentRaw, tabWidth),
      content: text.slice(indentRaw.length),
    }];
  });
  const unitColumns = inferIndentationUnit(sourceLines);
  const newline = newlineStyle(source);
  const nodes: CodeGraphNode[] = [];
  const rootIds: string[] = [];
  const diagnostics: CodeGraphDiagnostic[] = [];
  const stack: CodeGraphNode[] = [];
  const ownStartLines = new Map<string, number>();
  let previousLine: SourceLine | undefined;
  let previousNode: CodeGraphNode | undefined;

  for (const line of sourceLines) {
    const canExtendPrevious =
      previousLine !== undefined &&
      previousNode !== undefined &&
      line.indentColumns === previousLine.indentColumns;

    if (canExtendPrevious && previousNode) {
      previousNode.range.endLine = line.number;
      previousLine = line;
      continue;
    }

    while (
      stack.length > 0 &&
      stack[stack.length - 1]!.indent.columns > line.indentColumns
    ) {
      stack.pop();
    }
    const openNodeAtIndent = stack.at(-1);
    if (openNodeAtIndent?.indent.columns === line.indentColumns) {
      openNodeAtIndent.range.endLine = line.number;
      if (line.indentRaw.includes(" ") && line.indentRaw.includes("\t")) {
        diagnostics.push({
          type: "mixed_indentation",
          line: line.number,
          message: "Leading indentation mixes spaces and tabs.",
        });
      }
      previousLine = line;
      previousNode = openNodeAtIndent;
      continue;
    }
    if (nodes.length >= maxNodes) {
      throw new Error(`Code graph exceeds the ${maxNodes}-node limit`);
    }
    const parent = stack.at(-1);
    const id = `n${nodes.length + 1}`;
    const startsAfterIndentIncrease =
      previousLine !== undefined &&
      line.indentColumns > previousLine.indentColumns;
    const node: CodeGraphNode = {
      id,
      kind: "indentation",
      parentId: parent?.id ?? null,
      childIds: [],
      depth: parent ? parent.depth + 1 : 0,
      indent: {
        raw: line.indentRaw,
        columns: line.indentColumns,
        level:
          line.indentColumns % unitColumns === 0
            ? line.indentColumns / unitColumns
            : null,
      },
      range: {
        startLine: Math.max(
          1,
          startsAfterIndentIncrease && previousLine
            ? previousLine.number
            : line.number,
        ),
        endLine: line.number,
      },
    };
    nodes.push(node);
    ownStartLines.set(id, line.number);
    if (parent) {
      parent.childIds.push(id);
      if (line.indentColumns - parent.indent.columns > unitColumns) {
        diagnostics.push({
          type: "indentation_jump",
          line: line.number,
          message:
            `Indentation jumps from ${parent.indent.columns} to ` +
            `${line.indentColumns} columns without an intermediate code node.`,
        });
      }
    } else {
      rootIds.push(id);
    }
    if (line.indentRaw.includes(" ") && line.indentRaw.includes("\t")) {
      diagnostics.push({
        type: "mixed_indentation",
        line: line.number,
        message: "Leading indentation mixes spaces and tabs.",
      });
    }
    stack.push(node);
    previousLine = line;
    previousNode = node;
  }

  for (const node of nodes) {
    let candidateLine = node.range.startLine - 1;
    while (candidateLine >= 1) {
      while (
        candidateLine >= 1 &&
        rawLines[candidateLine - 1]?.trim().length === 0
      ) {
        candidateLine -= 1;
      }
      if (
        candidateLine < 1 ||
        !startsWithLeadingMarker(rawLines[candidateLine - 1] ?? "")
      ) {
        break;
      }
      node.range.startLine = Math.min(node.range.startLine, candidateLine);
      candidateLine -= 1;
    }
  }

  for (const node of nodes) {
    while (
      node.range.startLine < node.range.endLine &&
      firstLineHasExcessClosing(rawLines[node.range.startLine - 1] ?? "")
    ) {
      node.range.startLine += 1;
    }
    while (
      node.range.endLine < rawLines.length &&
      !delimitersBalanced(
        scanDelimiters(rawLines, node.range.startLine, node.range.endLine),
      )
    ) {
      node.range.endLine += 1;
    }
    if (
      !delimitersBalanced(
        scanDelimiters(rawLines, node.range.startLine, node.range.endLine),
      )
    ) {
      diagnostics.push({
        type: "unbalanced_delimiters",
        line: node.range.startLine,
        message: `Node ${node.id} remains delimiter-unbalanced at end of file.`,
      });
    }
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of [...nodes].reverse()) {
    if (!node.parentId) continue;
    const parent = nodesById.get(node.parentId);
    if (!parent) continue;
    parent.range.startLine = Math.min(parent.range.startLine, node.range.startLine);
    parent.range.endLine = Math.max(parent.range.endLine, node.range.endLine);
  }
  const indentationNodes = [...nodes];
  for (const parent of indentationNodes) {
    const indentationChildren = parent.childIds
      .map((childId) => nodesById.get(childId))
      .filter((child): child is CodeGraphNode => child !== undefined)
      .sort((left, right) => left.range.startLine - right.range.startLine);
    if (indentationChildren.length === 0) continue;

    const parentOwnStart = ownStartLines.get(parent.id) ?? parent.range.startLine;
    let cursor = parentOwnStart;
    const addRemainder = (startLine: number, endLine: number): void => {
      while (
        startLine <= endLine &&
        rawLines[startLine - 1]?.trim().length === 0
      ) {
        startLine += 1;
      }
      while (
        endLine >= startLine &&
        rawLines[endLine - 1]?.trim().length === 0
      ) {
        endLine -= 1;
      }
      while (
        startLine < endLine &&
        firstLineHasExcessClosing(rawLines[startLine - 1] ?? "")
      ) {
        startLine += 1;
      }
      if (startLine > endLine) return;
      if (!delimitersBalanced(scanDelimiters(rawLines, startLine, endLine))) {
        diagnostics.push({
          type: "unbalanced_remainder_skipped",
          line: startLine,
          message:
            `Skipped delimiter-unbalanced remainder ${startLine}-${endLine} ` +
            `inside ${parent.id}.`,
        });
        return;
      }
      if (nodes.length >= maxNodes) {
        throw new Error(`Code graph exceeds the ${maxNodes}-node limit`);
      }
      const id = `n${nodes.length + 1}`;
      const remainder: CodeGraphNode = {
        id,
        kind: "parent-remainder",
        parentId: parent.id,
        childIds: [],
        depth: parent.depth + 1,
        indent: { ...parent.indent },
        range: { startLine, endLine },
      };
      nodes.push(remainder);
      nodesById.set(id, remainder);
      parent.childIds.push(id);
    };

    for (const child of indentationChildren) {
      if (cursor < child.range.startLine) {
        addRemainder(cursor, child.range.startLine - 1);
      }
      cursor = Math.max(cursor, child.range.endLine + 1);
    }
    if (cursor <= parent.range.endLine) {
      addRemainder(cursor, parent.range.endLine);
    }
  }
  for (const node of nodes) {
    node.childIds.sort((leftId, rightId) => {
      const left = nodesById.get(leftId)!;
      const right = nodesById.get(rightId)!;
      return (
        left.range.startLine - right.range.startLine ||
        left.range.endLine - right.range.endLine
      );
    });
  }
  return {
    version: 1,
    kind: "indentation-code-graph",
    source: {
      path: options.path ?? null,
      sha256: createHash("sha256").update(source).digest("hex"),
      lineCount: rawLines.length,
      newline,
      hasFinalNewline: /(?:\r\n|\n|\r)$/.test(source),
    },
    indentation: { unitColumns, tabWidth },
    rangeContext: {
      startLine: "previous-line-on-indent-increase",
      endLine: "exact",
    },
    delimiterPolicy: {
      pairs: ["()", "{}", "[]"],
      quotes: "even-unescaped-single-and-double",
      leadingExcessClosing: "trim",
      unbalancedRemainders: "skip",
    },
    leadingLinePolicy: {
      markers: ["//", "#", "@", "!"],
      skipBlankLines: true,
      overlapAllowed: true,
    },
    rootIds,
    nodes,
    diagnostics,
  };
}
