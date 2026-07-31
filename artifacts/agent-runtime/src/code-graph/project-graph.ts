import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { graphCode, type CodeGraphDiagnostic, type CodeGraphNode } from "./code-graph";

export const PROJECT_GRAPH_PATH = "graph/project_graph.json";

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".kt", ".lua", ".php", ".py", ".rb", ".rs",
  ".scala", ".sh", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue",
]);
const SKIPPED_DIRECTORIES = new Set([
  ".git", ".next", ".turbo", ".venv", "__pycache__", "build", "dist",
  "graph", "node_modules", "out", "target", "venv",
]);
const MAX_SOURCE_FILE_CHARACTERS = 2_000_000;
const MAX_SOURCE_FILES = 20_000;

export interface ProjectGraphFile {
  path: string;
  sha256: string;
  lineCount: number;
  content: string;
  rootIds: string[];
  nodes: CodeGraphNode[];
  diagnostics: CodeGraphDiagnostic[];
}

export interface ProjectGraph {
  version: 1;
  kind: "project-code-graph";
  generatedAt: string;
  files: ProjectGraphFile[];
  skippedFiles: Array<{ path: string; reason: string }>;
  totals: {
    files: number;
    nodes: number;
    sourceCharacters: number;
  };
}

export interface BuildProjectGraphOptions {
  outputPath?: string;
  writeToDisk?: boolean;
  readSource?: (relativePath: string) => Promise<string>;
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function globalNodeId(path: string, localId: string): string {
  const pathHash = createHash("sha256").update(path).digest("hex").slice(0, 16);
  return `${pathHash}:${localId}`;
}

async function discoverSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (files.length >= MAX_SOURCE_FILES) return;
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_SOURCE_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      files.push(portablePath(relative(root, absolutePath)));
    }
  };
  await visit(root);
  return files;
}

export async function buildProjectGraph(
  workspaceRoot: string,
  options: BuildProjectGraphOptions = {},
): Promise<ProjectGraph> {
  const root = resolve(workspaceRoot);
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`Project graph workspace is not a directory: ${root}`);
  }
  const paths = await discoverSourceFiles(root);
  const files: ProjectGraphFile[] = [];
  const skippedFiles: ProjectGraph["skippedFiles"] = [];

  for (const path of paths) {
    let content: string;
    try {
      content = options.readSource
        ? await options.readSource(path)
        : await readFile(join(root, ...path.split("/")), "utf8");
    } catch (error) {
      skippedFiles.push({
        path,
        reason: `read failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (content.includes("\u0000")) {
      skippedFiles.push({ path, reason: "binary content" });
      continue;
    }
    if (content.length > MAX_SOURCE_FILE_CHARACTERS) {
      skippedFiles.push({
        path,
        reason: `exceeds ${MAX_SOURCE_FILE_CHARACTERS} characters`,
      });
      continue;
    }

    const fileGraph = graphCode(content, { path, maxNodes: 5_000 });
    const idMap = new Map(
      fileGraph.nodes.map((node) => [node.id, globalNodeId(path, node.id)]),
    );
    files.push({
      path,
      sha256: fileGraph.source.sha256,
      lineCount: fileGraph.source.lineCount,
      content,
      rootIds: fileGraph.rootIds.map((id) => idMap.get(id)!),
      nodes: fileGraph.nodes.map((node) => ({
        ...node,
        id: idMap.get(node.id)!,
        parentId: node.parentId ? idMap.get(node.parentId)! : null,
        childIds: node.childIds.map((id) => idMap.get(id)!),
      })),
      diagnostics: fileGraph.diagnostics,
    });
  }

  const graph: ProjectGraph = {
    version: 1,
    kind: "project-code-graph",
    generatedAt: new Date().toISOString(),
    files,
    skippedFiles,
    totals: {
      files: files.length,
      nodes: files.reduce((total, file) => total + file.nodes.length, 0),
      sourceCharacters: files.reduce(
        (total, file) => total + file.content.length,
        0,
      ),
    },
  };

  if (options.writeToDisk !== false) {
    const outputPath = options.outputPath ?? PROJECT_GRAPH_PATH;
    const absoluteOutput = resolve(root, ...outputPath.split("/"));
    const relativeOutput = relative(root, absoluteOutput);
    if (
      relativeOutput === ".." ||
      relativeOutput.startsWith(`..${sep}`) ||
      resolve(absoluteOutput) === root
    ) {
      throw new Error(`Project graph output escapes the workspace: ${outputPath}`);
    }
    await mkdir(dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  }
  return graph;
}
