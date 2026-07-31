import { readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { WorkspaceAccess } from "@workspace/agent-runtime";

export const RELEVANT_CODE_LIMITS = {
  maxFiles: 3,
  maxLinesPerFile: 80,
  maxTotalLines: 160,
  maxTotalCharacters: 12_000,
  maxDiscoveryEntries: 5_000,
} as const;

export interface RelevantCodeExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface RelevantCodeContext {
  excerpts: RelevantCodeExcerpt[];
  totalLines: number;
  totalCharacters: number;
  truncated: boolean;
}

export interface RelevantCodeSource {
  path: string;
  content: string;
  startLine?: number;
}

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".kt", ".php", ".py", ".rb", ".rs", ".scala",
  ".sh", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue",
]);
const SKIPPED_DIRECTORIES = new Set([
  ".git", ".next", ".turbo", ".venv", "build", "dist", "node_modules",
  "out", "target", "venv", "__pycache__",
]);
const FILE_REFERENCE =
  /(?:[A-Za-z0-9_.@-]+[\\/])*[A-Za-z0-9_.@-]+\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|kt|php|py|rb|rs|scala|sh|sql|svelte|swift|ts|tsx|vue)\b/gi;

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function hintTerms(text: string): string[] {
  const terms = text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const ignored = new Set([
    "actual", "already", "and", "code", "current", "file", "from", "into",
    "learner", "next", "node", "project", "should", "step", "that", "the",
    "this", "with",
  ]);
  return [...new Set(terms.map((term) => term.toLowerCase()).filter((term) => !ignored.has(term)))]
    .slice(0, 80);
}

function bestLineIndex(lines: string[], terms: string[]): number {
  let bestIndex = 0;
  let bestScore = -1;
  for (const [index, line] of lines.entries()) {
    const lower = line.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score += 2;
    }
    if (/^\s*(?:class|def|function|interface|type|const|let|export)\b/.test(line)) {
      score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function sourceScore(source: RelevantCodeSource, terms: string[]): number {
  const path = source.path.toLowerCase();
  const content = source.content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (path.includes(term)) score += 8;
    if (content.includes(term)) score += 1;
  }
  return score;
}

/**
 * Converts exact file reads into a small evidence packet. It never summarizes
 * or rewrites code: excerpts are copied verbatim with their original line range.
 */
export function buildRelevantCodeContext(
  sources: RelevantCodeSource[],
  hints: string,
): RelevantCodeContext {
  const terms = hintTerms(hints);
  const unique = new Map<string, RelevantCodeSource>();
  for (const source of sources) {
    const path = portablePath(source.path.trim());
    if (!path || !source.content || !isSourcePath(path)) continue;
    unique.set(path.toLowerCase(), {
      path,
      content: source.content,
      startLine: source.startLine,
    });
  }

  const ranked = [...unique.values()]
    .sort((a, b) => sourceScore(b, terms) - sourceScore(a, terms))
    .slice(0, RELEVANT_CODE_LIMITS.maxFiles);

  const excerpts: RelevantCodeExcerpt[] = [];
  let totalLines = 0;
  let totalCharacters = 0;
  let truncated = unique.size > ranked.length;

  for (const source of ranked) {
    if (
      totalLines >= RELEVANT_CODE_LIMITS.maxTotalLines ||
      totalCharacters >= RELEVANT_CODE_LIMITS.maxTotalCharacters
    ) {
      truncated = true;
      break;
    }

    const lines = source.content.split(/\r?\n/);
    const remainingLines = RELEVANT_CODE_LIMITS.maxTotalLines - totalLines;
    const allowedLines = Math.min(RELEVANT_CODE_LIMITS.maxLinesPerFile, remainingLines);
    const center = bestLineIndex(lines, terms);
    let start = Math.max(0, center - Math.floor(allowedLines / 2));
    let end = Math.min(lines.length, start + allowedLines);
    start = Math.max(0, end - allowedLines);

    let selected = lines.slice(start, end);
    const remainingCharacters = RELEVANT_CODE_LIMITS.maxTotalCharacters - totalCharacters;
    let content = selected.join("\n");
    if (content.length > remainingCharacters) {
      content = content.slice(0, remainingCharacters);
      selected = content.split(/\r?\n/);
      end = start + selected.length;
      truncated = true;
    }
    if (!content) continue;

    const sourceStartLine = source.startLine ?? 1;
    excerpts.push({
      path: source.path,
      startLine: sourceStartLine + start,
      endLine: sourceStartLine + end - 1,
      content,
    });
    totalLines += selected.length;
    totalCharacters += content.length;
    if (start > 0 || end < lines.length) truncated = true;
  }

  return { excerpts, totalLines, totalCharacters, truncated };
}

export function extractReferencedSourcePaths(text: string): string[] {
  return [...new Set((text.match(FILE_REFERENCE) ?? []).map((path) => portablePath(path)))]
    .slice(0, 20);
}

async function discoverByBasename(root: string, wanted: Set<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let visited = 0;

  const walk = async (directory: string): Promise<void> => {
    if (
      wanted.size === found.size ||
      visited >= RELEVANT_CODE_LIMITS.maxDiscoveryEntries
    ) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (visited >= RELEVANT_CODE_LIMITS.maxDiscoveryEntries) return;
      visited += 1;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(child.name)) await walk(join(directory, child.name));
        continue;
      }
      const lower = child.name.toLowerCase();
      if (wanted.has(lower) && !found.has(lower)) {
        found.set(lower, portablePath(relative(root, join(directory, child.name))));
      }
    }
  };

  await walk(root);
  return found;
}

/**
 * Re-reads only file paths named by the planner/step handoff. When a handoff
 * gives only a basename, discovery scans names (not file contents), bounded at
 * 5,000 entries and excluding dependency/build directories.
 */
export async function readRelevantCodeContext(
  workspaceRoot: string,
  referenceText: string,
  hints: string,
): Promise<RelevantCodeContext> {
  const workspace = new WorkspaceAccess(workspaceRoot);
  const references = extractReferencedSourcePaths(referenceText);
  const sources: RelevantCodeSource[] = [];
  const unresolved: string[] = [];

  for (const path of references) {
    try {
      sources.push({ path, content: await workspace.readTextFile(path) });
    } catch {
      unresolved.push(path);
    }
  }

  if (unresolved.length > 0 && sources.length < RELEVANT_CODE_LIMITS.maxFiles) {
    const wanted = new Set(unresolved.map((path) => basename(path).toLowerCase()));
    const discovered = await discoverByBasename(workspaceRoot, wanted);
    for (const path of discovered.values()) {
      if (sources.some((source) => source.path.toLowerCase() === path.toLowerCase())) continue;
      try {
        sources.push({ path, content: await workspace.readTextFile(path) });
      } catch {
        // A file can disappear between discovery and read; simply skip it.
      }
    }
  }

  return buildRelevantCodeContext(sources, hints);
}

export function formatRelevantCodeContext(context?: RelevantCodeContext): string {
  if (!context || context.excerpts.length === 0) return "";
  const blocks = context.excerpts.map(
    (excerpt) =>
      `File: ${excerpt.path}, lines ${excerpt.startLine}-${excerpt.endLine}\n\`\`\`\n${excerpt.content}\n\`\`\``,
  );
  return `${blocks.join("\n\n")}\n\nEvidence budget: ${context.excerpts.length} file(s), ${context.totalLines} line(s), ${context.totalCharacters} characters${context.truncated ? " (bounded/truncated)" : ""}.`;
}
