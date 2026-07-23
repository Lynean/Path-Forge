import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", "venv", ".venv",
  "__pycache__", ".turbo", "target", "out", ".cache", ".idea", ".vscode",
]);

// Manifests / entry docs worth showing in full (truncated) so the planner can
// see the actual stack and setup rather than guessing from file names.
const KEY_FILES = [
  "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "Gemfile", "composer.json", "Dockerfile",
  "docker-compose.yml", "README.md", "README",
];

const NULL_BYTE = String.fromCharCode(0);

export interface WorkspaceSnapshotOptions {
  maxEntries?: number;
  maxDepth?: number;
  maxKeyFileChars?: number;
  maxTotalChars?: number;
}

/**
 * Builds a compact, bounded text snapshot of a real local project folder — its
 * file tree plus key manifests/README — for grounding the planner in what the
 * learner already has. Returns null if the path isn't a readable directory.
 */
export async function readWorkspaceSnapshot(
  root: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<string | null> {
  const maxEntries = options.maxEntries ?? 200;
  const maxDepth = options.maxDepth ?? 4;
  const maxKeyFileChars = options.maxKeyFileChars ?? 4000;
  const maxTotalChars = options.maxTotalChars ?? 12000;

  try {
    if (!(await stat(root)).isDirectory()) return null;
  } catch {
    return null;
  }

  const entries: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (entries.length >= maxEntries) return;
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (entries.length >= maxEntries) return;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory() && SKIP_DIRS.has(child.name)) continue;
      const abs = join(dir, child.name);
      const rel = relative(root, abs).split(sep).join("/");
      entries.push(child.isDirectory() ? `${rel}/` : rel);
      if (child.isDirectory() && depth < maxDepth) await walk(abs, depth + 1);
    }
  };
  await walk(root, 1);
  if (entries.length === 0) return null;

  const keyBlocks: string[] = [];
  for (const name of KEY_FILES) {
    try {
      const content = await readFile(join(root, name), "utf8");
      if (content.includes(NULL_BYTE)) continue; // skip binary
      keyBlocks.push(`--- ${name} ---\n${content.slice(0, maxKeyFileChars)}`);
    } catch {
      // not present — skip
    }
  }

  const truncated = entries.length >= maxEntries;
  let out = `File tree (${entries.length}${truncated ? "+" : ""} entries):\n${entries.map((e) => `- ${e}`).join("\n")}`;
  if (keyBlocks.length > 0) out += `\n\nKey files:\n${keyBlocks.join("\n\n")}`;
  return out.length > maxTotalChars ? `${out.slice(0, maxTotalChars)}\n… snapshot truncated …` : out;
}
