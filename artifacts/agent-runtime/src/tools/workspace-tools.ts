import { readdir, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { z } from "zod/v4";
import { WorkspaceAccess } from "../workspace/workspace-access";
import type { AgentTool } from "./tool";

const DEFAULT_MAX_FILE_CHARS = 100_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "build",
  "dist",
  "graph",
  "node_modules",
]);

function portablePath(path: string): string {
  return path.split(sep).join("/") || ".";
}

export class ReadFileTool implements AgentTool {
  readonly name = "read_file";
  readonly description =
    "Read a UTF-8 text file inside the user-approved workspace. For a large file, use search_code first, then pass startLine/endLine to read only the relevant range.";
  readonly inputSchema = z
    .object({
      path: z.string().min(1),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    })
    .strict()
    .refine(
      ({ startLine, endLine }) =>
        startLine === undefined || endLine === undefined || endLine >= startLine,
      { message: "endLine must be greater than or equal to startLine" },
    );

  constructor(
    private readonly workspace: WorkspaceAccess,
    private readonly maxCharacters = DEFAULT_MAX_FILE_CHARS,
    private readonly maxExecutions = Number.POSITIVE_INFINITY,
  ) {}

  private executions = 0;

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    if (this.executions >= this.maxExecutions) {
      return {
        error: "READ_FILE_LIMIT_REACHED",
        message: `This inspection is limited to ${this.maxExecutions} source-file reads. Use the evidence already collected.`,
      };
    }
    const relativePath = arguments_["path"] as string;
    const content = await this.workspace.readTextFile(relativePath);
    this.executions += 1;
    const lines = content.split(/\r?\n/);
    const requestedStart = (arguments_["startLine"] as number | undefined) ?? 1;
    const requestedEnd = (arguments_["endLine"] as number | undefined) ?? lines.length;
    const startIndex = Math.min(requestedStart - 1, lines.length);
    const endIndex = Math.min(requestedEnd, lines.length);
    const selected = lines.slice(startIndex, endIndex).join("\n");
    const clipped = selected.slice(0, this.maxCharacters);
    const includedLines = clipped ? clipped.split(/\r?\n/).length : 0;
    return {
      path: relativePath,
      content: clipped,
      startLine: startIndex + 1,
      endLine: includedLines > 0 ? startIndex + includedLines : startIndex + 1,
      totalLines: lines.length,
      truncated:
        startIndex > 0 ||
        endIndex < lines.length ||
        selected.length > this.maxCharacters,
    };
  }
}

export class ListFilesTool implements AgentTool {
  readonly name = "list_files";
  readonly description =
    "List files and directories inside the user-approved workspace. If the result is truncated, request a narrower path; never repeat identical arguments.";
  readonly inputSchema = z
    .object({
      path: z.string().min(1).default("."),
      depth: z.number().int().min(1).max(4).default(2),
    })
    .strict();

  constructor(
    private readonly workspace: WorkspaceAccess,
    private readonly maximumEntries = 300,
  ) {}

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    const requestedPath = arguments_["path"] as string;
    const maximumDepth = arguments_["depth"] as number;
    const root = await this.workspace.root();
    const start = await this.workspace.resolveDirectory(requestedPath);
    const entries: Array<{ path: string; type: "file" | "directory" }> = [];

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (entries.length >= this.maximumEntries) return;
      const children = await readdir(directory, { withFileTypes: true });

      for (const child of children) {
        if (entries.length >= this.maximumEntries) return;
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory() && SKIPPED_DIRECTORIES.has(child.name)) continue;

        const absolutePath = `${directory}${sep}${child.name}`;
        entries.push({
          path: portablePath(relative(root, absolutePath)),
          type: child.isDirectory() ? "directory" : "file",
        });

        if (child.isDirectory() && depth < maximumDepth) {
          await visit(absolutePath, depth + 1);
        }
      }
    };

    await visit(start, 1);
    const requestedPrefix = requestedPath === "." ? "" : `${requestedPath.replace(/\/$/, "")}/`;
    for (const stagedPath of this.workspace.stagedPaths()) {
      if (!stagedPath.startsWith(requestedPrefix)) continue;
      const remainder = stagedPath.slice(requestedPrefix.length);
      if (remainder.split("/").length > maximumDepth) continue;
      if (!entries.some((entry) => entry.path === stagedPath)) {
        entries.push({ path: stagedPath, type: "file" });
      }
    }
    return { entries, truncated: entries.length >= this.maximumEntries };
  }
}

export class SearchCodeTool implements AgentTool {
  readonly name = "search_code";
  readonly description = "Search UTF-8 project files for a literal text query.";
  readonly inputSchema = z
    .object({
      query: z.string().min(1).max(200),
      path: z.string().min(1).default("."),
      maxResults: z.number().int().min(1).max(100).default(30),
    })
    .strict();

  constructor(private readonly workspace: WorkspaceAccess) {}

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    const query = (arguments_["query"] as string).toLowerCase();
    const requestedPath = arguments_["path"] as string;
    const maxResults = arguments_["maxResults"] as number;
    const root = await this.workspace.root();
    const start = await this.workspace.resolveDirectory(requestedPath);
    const matches: Array<{ path: string; line: number; text: string }> = [];

    const visit = async (directory: string): Promise<void> => {
      if (matches.length >= maxResults) return;
      const children = await readdir(directory, { withFileTypes: true });

      for (const child of children) {
        if (matches.length >= maxResults) return;
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(child.name)) {
            await visit(`${directory}${sep}${child.name}`);
          }
          continue;
        }

        const absolutePath = `${directory}${sep}${child.name}`;
        if ((await stat(absolutePath)).size > 512_000) continue;

        let content: string;
        try {
          content = await this.workspace.readTextFile(
            portablePath(relative(root, absolutePath)),
          );
        } catch {
          continue;
        }
        if (content.includes("\u0000")) continue;

        const lines = content.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (line.toLowerCase().includes(query)) {
            matches.push({
              path: portablePath(relative(root, absolutePath)),
              line: index + 1,
              text: line.slice(0, 500),
            });
            if (matches.length >= maxResults) return;
          }
        }
      }
    };

    await visit(start);
    for (const stagedPath of this.workspace.stagedPaths()) {
      if (matches.length >= maxResults) break;
      const requestedPrefix = requestedPath === "." ? "" : `${requestedPath.replace(/\/$/, "")}/`;
      if (!stagedPath.startsWith(requestedPrefix)) continue;
      let existsOnDisk = true;
      try {
        await this.workspace.resolveFile(stagedPath);
      } catch {
        existsOnDisk = false;
      }
      if (existsOnDisk) continue;
      const lines = (await this.workspace.readTextFile(stagedPath)).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (line.toLowerCase().includes(query)) {
          matches.push({ path: stagedPath, line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= maxResults) break;
        }
      }
    }
    return { matches, truncated: matches.length >= maxResults };
  }
}

export class InspectProjectTool implements AgentTool {
  readonly name = "inspect_project";
  readonly description = "Inspect the top-level structure and common manifests of the workspace.";
  readonly inputSchema = z.object({}).strict();

  constructor(private readonly workspace: WorkspaceAccess) {}

  async execute(_arguments: Record<string, unknown>): Promise<unknown> {
    const root = await this.workspace.root();
    const children = await readdir(root, { withFileTypes: true });
    const entries = children
      .filter((child) => !child.isSymbolicLink())
      .map((child) => ({
        name: child.name,
        type: child.isDirectory() ? "directory" : "file",
      }));
    for (const stagedPath of this.workspace.stagedPaths()) {
      const name = stagedPath.split("/")[0]!;
      if (!entries.some((entry) => entry.name === name)) {
        entries.push({ name, type: stagedPath.includes("/") ? "directory" : "file" });
      }
    }
    const manifests: Record<string, string> = {};

    for (const name of [
      "package.json",
      "pyproject.toml",
      "requirements.txt",
      "uv.lock",
      "Cargo.toml",
      "go.mod",
    ]) {
      try {
        manifests[name] = (await this.workspace.readTextFile(name)).slice(0, 20_000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    return { entries, manifests };
  }
}
