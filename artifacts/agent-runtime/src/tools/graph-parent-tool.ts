import { z } from "zod/v4";
import type {
  ProjectGraph,
  ProjectGraphFile,
} from "../code-graph/project-graph";
import type { CodeGraphNode } from "../code-graph/code-graph";
import type { GraphSearchMatch } from "./graph-search-tool";
import { ProjectGraphStore } from "./project-graph-store";
import type { AgentTool } from "./tool";

const DEFAULT_MAX_PARENT_CHARACTERS = 24_000;

export interface GraphParentNode extends GraphSearchMatch {
  NodeCodeTruncated: boolean;
  NodeCodeCharacters: number;
}

export type GraphParentResult =
  | {
      ok: true;
      node_id: string;
      parent: GraphParentNode | null;
    }
  | {
      ok: false;
      node_id: string;
      error: "GRAPH_NODE_NOT_FOUND" | "GRAPH_PARENT_NOT_FOUND";
      message: string;
    };

function nodeCode(file: ProjectGraphFile, node: CodeGraphNode): string {
  return file.content
    .split(/\r\n|\n|\r/)
    .slice(node.range.startLine - 1, node.range.endLine)
    .join("\n");
}

export function findGraphParent(
  graph: ProjectGraph,
  nodeId: string,
  maxCharacters = DEFAULT_MAX_PARENT_CHARACTERS,
): GraphParentResult {
  let childFile: ProjectGraphFile | undefined;
  let child: CodeGraphNode | undefined;
  for (const file of graph.files) {
    const match = file.nodes.find((node) => node.id === nodeId);
    if (match) {
      childFile = file;
      child = match;
      break;
    }
  }
  if (!child || !childFile) {
    return {
      ok: false,
      node_id: nodeId,
      error: "GRAPH_NODE_NOT_FOUND",
      message: `No project-graph node exists with id ${nodeId}.`,
    };
  }
  if (!child.parentId) {
    return { ok: true, node_id: nodeId, parent: null };
  }
  const parent = childFile.nodes.find((node) => node.id === child.parentId);
  if (!parent) {
    return {
      ok: false,
      node_id: nodeId,
      error: "GRAPH_PARENT_NOT_FOUND",
      message: `Node ${nodeId} references missing parent ${child.parentId}.`,
    };
  }
  const code = nodeCode(childFile, parent);
  return {
    ok: true,
    node_id: nodeId,
    parent: {
      path: childFile.path,
      node_id: parent.id,
      range_of_node: parent.range,
      parent_node_id: parent.parentId,
      NodeCode: code.slice(0, maxCharacters),
      NodeCodeTruncated: code.length > maxCharacters,
      NodeCodeCharacters: code.length,
    },
  };
}

export class GraphParentTool implements AgentTool {
  readonly name = "graph_parent";
  readonly description =
    "Expand one graph_search result to its immediate parent when the youngest node lacks enough context. Pass the result's node_id. Returns the parent node ID, range, its own parent ID, and bounded code; call graph_parent again with the returned parent node_id to move upward. Root nodes return parent=null.";
  readonly inputSchema = z
    .object({
      node_id: z.string().min(1).max(200),
    })
    .strict();

  constructor(
    private readonly graphStore: ProjectGraphStore,
    private readonly maxCharacters = DEFAULT_MAX_PARENT_CHARACTERS,
  ) {}

  async execute(arguments_: Record<string, unknown>): Promise<GraphParentResult> {
    return findGraphParent(
      await this.graphStore.get(),
      arguments_["node_id"] as string,
      this.maxCharacters,
    );
  }
}
