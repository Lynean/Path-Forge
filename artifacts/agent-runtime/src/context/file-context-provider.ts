import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentContextDocuments, AgentTurnInput } from "../contracts";
import type { AgentContextProvider } from "./context-provider";

export interface FileContextProviderOptions {
  agentHome: string;
  workspaceRoot: string;
}

async function readOptionalMarkdown(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Loads user-controlled context documents without allowing the model to choose paths. */
export class FileContextProvider implements AgentContextProvider {
  constructor(private readonly options: FileContextProviderOptions) {}

  async load(_input: AgentTurnInput): Promise<AgentContextDocuments> {
    const [soul, user, project] = await Promise.all([
      readOptionalMarkdown(join(this.options.agentHome, "SOUL.md")),
      readOptionalMarkdown(join(this.options.agentHome, "USER.md")),
      readOptionalMarkdown(join(this.options.workspaceRoot, "PROJECT.md")),
    ]);

    return { soul, user, project };
  }
}
