import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

export class WorkspaceAccess {
  private readonly rootPromise: Promise<string>;
  private readonly edits = new Map<
    string,
    { path: string; originalContent: string | null; content: string }
  >();
  private readonly maxEditedFiles: number;
  private readonly maxChangedLines: number;
  private readonly maxFileCharacters: number;

  constructor(
    workspaceRoot: string,
    limits: {
      maxEditedFiles?: number;
      maxChangedLines?: number;
      maxFileCharacters?: number;
    } = {},
  ) {
    this.rootPromise = realpath(resolve(workspaceRoot));
    this.maxEditedFiles = limits.maxEditedFiles ?? 10;
    this.maxChangedLines = limits.maxChangedLines ?? 500;
    this.maxFileCharacters = limits.maxFileCharacters ?? 200_000;
  }

  async root(): Promise<string> {
    return this.rootPromise;
  }

  async resolveExisting(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) {
      throw new Error("Workspace tool paths must be relative");
    }

    const root = await this.rootPromise;
    const lexicalTarget = resolve(root, relativePath);
    if (!isInside(root, lexicalTarget)) {
      throw new Error(`Path escapes the approved workspace: ${relativePath}`);
    }

    const physicalTarget = await realpath(lexicalTarget);
    if (!isInside(root, physicalTarget)) {
      throw new Error(`Path resolves outside the approved workspace: ${relativePath}`);
    }

    return physicalTarget;
  }

  async resolveFile(relativePath: string): Promise<string> {
    const path = await this.resolveExisting(relativePath);
    if (!(await stat(path)).isFile()) {
      throw new Error(`Expected a file inside the workspace: ${relativePath}`);
    }
    return path;
  }

  async resolveDirectory(relativePath: string): Promise<string> {
    const path = await this.resolveExisting(relativePath);
    if (!(await stat(path)).isDirectory()) {
      throw new Error(`Expected a directory inside the workspace: ${relativePath}`);
    }
    return path;
  }

  private portablePath(relativePath: string): string {
    if (
      !relativePath ||
      relativePath === "." ||
      isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath.includes("\0")
    ) {
      throw new Error("Edited file paths must be portable relative file paths");
    }
    const normalized = relativePath.split("/").filter(Boolean).join("/");
    const segments = normalized.split("/");
    if (
      segments.some(
        (segment) =>
          segment === "." ||
          segment === ".." ||
          !/^[A-Za-z0-9._@()+,\- ]+$/.test(segment) ||
          segment.endsWith(".") ||
          segment.endsWith(" ") ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
      )
    ) {
      throw new Error(`Edited file path escapes the workspace: ${relativePath}`);
    }
    const protectedNames = new Set([
      ".git",
      ".env",
      ".npmrc",
      ".pypirc",
      "soul.md",
      "user.md",
    ]);
    if (
      segments.some((segment) => protectedNames.has(segment.toLowerCase())) ||
      segments.some((segment) => segment.toLowerCase().startsWith(".env."))
    ) {
      throw new Error(`This file is protected from agent edits: ${relativePath}`);
    }
    return normalized;
  }

  async readTextFile(relativePath: string): Promise<string> {
    const normalized = this.portablePath(relativePath);
    const staged = this.edits.get(normalized);
    if (staged) return staged.content;
    return await readFile(await this.resolveFile(normalized), "utf8");
  }

  async stageTextReplacement(
    relativePath: string,
    oldText: string | null,
    newText: string,
  ): Promise<{
    path: string;
    created: boolean;
    changedLines: number;
    diff: string;
  }> {
    const normalized = this.portablePath(relativePath);
    if (newText.length > this.maxFileCharacters) {
      throw new Error(`Edited file exceeds the ${this.maxFileCharacters}-character limit`);
    }
    let current: string | null;
    const existingEdit = this.edits.get(normalized);
    if (existingEdit) {
      current = existingEdit.content;
    } else {
      const root = await this.rootPromise;
      const lexicalTarget = resolve(root, normalized);
      if (!isInside(root, lexicalTarget)) {
        throw new Error(`Path escapes the approved workspace: ${relativePath}`);
      }
      const physicalParent = await realpath(dirname(lexicalTarget));
      if (!isInside(root, physicalParent) || !(await stat(physicalParent)).isDirectory()) {
        throw new Error(`New files require an existing workspace directory: ${relativePath}`);
      }
      try {
        const fileInfo = await lstat(lexicalTarget);
        if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
          throw new Error(`Edited path must be a regular file: ${relativePath}`);
        }
        current = await readFile(lexicalTarget, "utf8");
        if (current.includes("\0")) throw new Error("Binary files cannot be edited");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        current = null;
      }
    }

    let next: string;
    if (oldText === null) {
      if (current !== null) {
        throw new Error(`New-file edit refused because the file already exists: ${relativePath}`);
      }
      next = newText;
    } else {
      if (current === null) throw new Error(`Cannot replace text in a missing file: ${relativePath}`);
      const first = current.indexOf(oldText);
      if (first < 0) throw new Error("The exact oldText was not found; inspect the latest file first");
      if (current.indexOf(oldText, first + oldText.length) >= 0) {
        throw new Error("oldText occurs more than once; provide a larger unique context block");
      }
      next = current.slice(0, first) + newText + current.slice(first + oldText.length);
    }

    const original = existingEdit?.originalContent ?? current;
    const candidateEdits = new Map(this.edits);
    candidateEdits.set(normalized, {
      path: normalized,
      originalContent: original,
      content: next,
    });
    if (candidateEdits.size > this.maxEditedFiles) {
      throw new Error(`A run may stage at most ${this.maxEditedFiles} files`);
    }
    const totalChangedLines = [...candidateEdits.values()].reduce(
      (total, edit) => total + changedLineCount(edit.originalContent, edit.content),
      0,
    );
    if (totalChangedLines > this.maxChangedLines) {
      throw new Error(`Staged edits exceed the ${this.maxChangedLines}-changed-line limit`);
    }
    this.edits.clear();
    for (const [path, edit] of candidateEdits) this.edits.set(path, edit);
    return {
      path: normalized,
      created: original === null,
      changedLines: changedLineCount(original, next),
      diff: renderDiff(normalized, original, next),
    };
  }

  stagedEdits(): Array<{ path: string; content: string }> {
    return [...this.edits.values()].map(({ path, content }) => ({ path, content }));
  }

  stagedPaths(): string[] {
    return [...this.edits.keys()];
  }
}

function changedLineCount(original: string | null, next: string): number {
  const before = original?.split(/\r?\n/) ?? [];
  const after = next.split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return before.length - prefix - suffix + (after.length - prefix - suffix);
}

function renderDiff(path: string, original: string | null, next: string): string {
  const beforeLines = original?.split(/\r?\n/) ?? [];
  const afterLines = next.split(/\r?\n/);
  const body = [
    `--- ${original === null ? "/dev/null" : `a/${path}`}`,
    `+++ b/${path}`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
  const maximum = 20_000;
  return body.length <= maximum
    ? body
    : `${body.slice(0, 6_000)}\n… diff shortened …\n${body.slice(-13_000)}`;
}
