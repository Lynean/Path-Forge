import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentMessageSchema, type AgentMessage } from "@workspace/agent-runtime";
import { z } from "zod/v4";

const conversationSchema = z.object({
  version: z.literal(1),
  messages: z.array(agentMessageSchema),
});

export class ConversationStore {
  constructor(private readonly directory: string) {}

  private pathFor(workspaceId: string): string {
    return join(this.directory, `${workspaceId}.json`);
  }

  async load(workspaceId: string): Promise<AgentMessage[]> {
    try {
      const parsed = conversationSchema.safeParse(
        JSON.parse(await readFile(this.pathFor(workspaceId), "utf8")),
      );
      if (!parsed.success) {
        throw new Error(`Saved conversation is invalid: ${parsed.error.message}`);
      }
      return parsed.data.messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(workspaceId: string, messages: AgentMessage[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(workspaceId);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      JSON.stringify({ version: 1, messages: messages.slice(-100) }, null, 2),
      "utf8",
    );
    await rename(temporaryPath, path);
  }

  async clear(workspaceId: string): Promise<void> {
    await this.save(workspaceId, []);
  }
}
