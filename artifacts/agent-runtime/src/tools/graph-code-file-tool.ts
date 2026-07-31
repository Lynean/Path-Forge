import { z } from "zod/v4";
import { graphCode } from "../code-graph/code-graph";
import { WorkspaceAccess } from "../workspace/workspace-access";
import type { AgentTool } from "./tool";

const DEFAULT_MAX_FILE_CHARACTERS = 500_000;

export class GraphCodeFileTool implements AgentTool {
  readonly name = "graph_code_file";
  readonly description =
    "Graph one UTF-8 code file into indentation and parent-remainder address nodes. Returns line ranges, parent/child links, indentation columns, and nesting depth without duplicating source code. Use read_file with a node's startLine/endLine to inspect only that block.";
  readonly inputSchema = z
    .object({
      path: z.string().min(1),
      tabWidth: z.number().int().min(1).max(16).default(4),
      maxNodes: z.number().int().min(1).max(5_000).default(2_000),
    })
    .strict();

  constructor(
    private readonly workspace: WorkspaceAccess,
    private readonly maxFileCharacters = DEFAULT_MAX_FILE_CHARACTERS,
  ) {}

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    const path = arguments_["path"] as string;
    const source = await this.workspace.readTextFile(path);
    if (source.length > this.maxFileCharacters) {
      return {
        error: "CODE_GRAPH_FILE_TOO_LARGE",
        message: `The file exceeds the ${this.maxFileCharacters}-character graphing limit.`,
      };
    }
    return graphCode(source, {
      path,
      tabWidth: arguments_["tabWidth"] as number,
      maxNodes: arguments_["maxNodes"] as number,
    });
  }
}
