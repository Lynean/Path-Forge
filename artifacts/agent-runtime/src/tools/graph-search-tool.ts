import { z } from "zod/v4";
import type { CodeGraphNode } from "../code-graph/code-graph";
import {
  type ProjectGraph,
  type ProjectGraphFile,
} from "../code-graph/project-graph";
import { WorkspaceAccess } from "../workspace/workspace-access";
import { ProjectGraphStore } from "./project-graph-store";
import type { AgentTool } from "./tool";

const DEFAULT_MAX_TOTAL_CHARACTERS = 24_000;
const STOP_WORDS = new Set<string>([
  "a", "an", "and", "code", "for", "from", "in", "is", "it", "of", "on",
  "or", "that", "the", "this", "to", "where", "which", "with",
]);

interface ScoredNode {
  file: ProjectGraphFile;
  node: CodeGraphNode;
  code: string;
  score: number;
}

export interface GraphSearchMatch {
  path: string;
  node_id: string;
  range_of_node: { startLine: number; endLine: number };
  parent_node_id: string | null;
  NodeCode: string;
}

export interface GraphSearchResult {
  query: string;
  matches: GraphSearchMatch[];
  searchedFiles: number;
  searchedNodes: number;
  truncated: boolean;
}

function queryTerms(query: string): string[] {
  const matches: string[] =
    query.toLowerCase().match(/[\p{L}\p{N}_$.-]+/gu) ?? [];
  return [
    ...new Set<string>(
      matches.filter(
        (term: string) => term.length >= 2 && !STOP_WORDS.has(term),
      ),
    ),
  ];
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (count < 5) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function nodeCode(lines: string[], node: CodeGraphNode): string {
  return lines
    .slice(node.range.startLine - 1, node.range.endLine)
    .join("\n");
}

export function searchProjectGraph(
  graph: ProjectGraph,
  queryInput: string,
  options: {
    path?: string;
    maxResults?: number;
    maxTotalCharacters?: number;
  } = {},
): GraphSearchResult {
  const query = queryInput.trim().toLowerCase();
  const terms = queryTerms(query);
  const pathFilter = options.path?.toLowerCase();
  const maxResults = options.maxResults ?? 5;
  const maxTotalCharacters =
    options.maxTotalCharacters ?? DEFAULT_MAX_TOTAL_CHARACTERS;
  const candidates: ScoredNode[] = [];
  const nodesById = new Map(
    graph.files.flatMap((file) =>
      file.nodes.map((node) => [node.id, node] as const),
    ),
  );

  for (const file of graph.files) {
    const lowerPath = file.path.toLowerCase();
    if (pathFilter && !lowerPath.includes(pathFilter)) continue;
    const lines = file.content.split(/\r\n|\n|\r/);
    for (const node of file.nodes) {
      const code = nodeCode(lines, node);
      const lowerCode = code.toLowerCase();
      if (!lowerCode.includes(query)) continue;
      let score = 100 + occurrences(lowerCode, query) * 6;
      for (const term of terms) {
        if (lowerPath.includes(term)) score += 12;
      }
      if (node.kind === "parent-remainder") score += 3;
      score -= Math.min(10, code.length / 4_000);
      candidates.push({ file, node, code, score });
    }
  }

  const matchingIds = new Set(candidates.map((candidate) => candidate.node.id));
  const matchingAncestors = new Set<string>();
  for (const candidate of candidates) {
    let parentId = candidate.node.parentId;
    while (parentId) {
      if (matchingIds.has(parentId)) matchingAncestors.add(parentId);
      parentId = nodesById.get(parentId)?.parentId ?? null;
    }
  }
  const youngestCandidates = candidates.filter(
    (candidate) => !matchingAncestors.has(candidate.node.id),
  );

  youngestCandidates.sort(
    (left, right) =>
      right.node.depth - left.node.depth ||
      right.score - left.score ||
      left.code.length - right.code.length ||
      left.file.path.localeCompare(right.file.path) ||
      left.node.range.startLine - right.node.range.startLine,
  );
  const uniqueRanges = new Set<string>();
  const uniqueYoungestCandidates = youngestCandidates.filter((candidate) => {
    const key =
      `${candidate.file.path}:${candidate.node.range.startLine}:` +
      `${candidate.node.range.endLine}`;
    if (uniqueRanges.has(key)) return false;
    uniqueRanges.add(key);
    return true;
  });
  const matches: GraphSearchMatch[] = [];
  let totalCharacters = 0;
  for (const candidate of uniqueYoungestCandidates) {
    if (matches.length >= maxResults) break;
    if (
      candidate.code.length > maxTotalCharacters ||
      totalCharacters + candidate.code.length > maxTotalCharacters
    ) {
      continue;
    }
    matches.push({
      path: candidate.file.path,
      node_id: candidate.node.id,
      range_of_node: candidate.node.range,
      parent_node_id: candidate.node.parentId,
      NodeCode: candidate.code,
    });
    totalCharacters += candidate.code.length;
  }
  return {
    query: queryInput,
    matches,
    searchedFiles: graph.totals.files,
    searchedNodes: graph.totals.nodes,
    truncated: matches.length < uniqueYoungestCandidates.length,
  };
}

export class GraphSearchTool implements AgentTool {
  readonly name = "graph_search";
  readonly description =
    "Find a literal string in the protected whole-project code graph and return only youngest matches: a matching parent is omitted whenever one of its descendants also contains the complete query. Deepest matches are returned first. Returns a bounded list of node IDs, file paths, ranges, parent IDs, and node code. Do not attempt to read graph/project_graph.json.";
  readonly inputSchema = z
    .object({
      query: z.string().min(2).max(500),
      path: z.string().min(1).optional(),
      maxResults: z.number().int().min(1).max(10).default(5),
    })
    .strict();

  constructor(
    workspace: WorkspaceAccess,
    private readonly graphStore = new ProjectGraphStore(workspace),
    private readonly maxTotalCharacters = DEFAULT_MAX_TOTAL_CHARACTERS,
  ) {}

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    const graph = await this.graphStore.get();
    return searchProjectGraph(graph, arguments_["query"] as string, {
      path: arguments_["path"] as string | undefined,
      maxResults: arguments_["maxResults"] as number,
      maxTotalCharacters: this.maxTotalCharacters,
    });
  }
}
