import { z } from "zod/v4";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@workspace/agent-runtime";

const MAX_LEN = 8000;

/**
 * Lets the tutor maintain its two ADAPTABLE memory docs — SOUL.md stays locked
 * (it holds the agent's guardrails). Both files are exactly what FileContextProvider
 * feeds back as context each turn, so writing them closes the memory loop:
 *   - target "user"    → USER.md in the agent home: durable facts about the LEARNER
 *                        that apply across every project.
 *   - target "project" → PROJECT.md in the project folder: durable state of THIS
 *                        project (what's built, decisions, layout, what's next).
 * Replace-in-full (the model is shown the current doc and resends the whole thing),
 * bounded by MAX_LEN, so the files can't grow without limit. This is a real,
 * deliberate write to those two specific files only — never SOUL.md, never any
 * other path.
 */
export class UpdateMemoryTool implements AgentTool {
  readonly name = "update_memory";
  readonly description =
    'Save durable memory that persists across turns and future sessions. target="user" rewrites USER.md — stable facts about the LEARNER that apply to EVERY project (skill level, preferred language, recurring strengths/struggles, how they like to be taught). target="project" rewrites PROJECT.md — the durable state of THIS project (what has been built so far, key decisions, file/module layout, what comes next). You are shown the current USER.md and PROJECT.md as context: edit and resend the FULL updated markdown in `content`. Keep it concise and factual — never store transient chatter, the current step, or one-off Q&A. You cannot edit SOUL.md.';
  readonly inputSchema = z
    .object({
      target: z.enum(["user", "project"]),
      content: z.string().min(1).max(MAX_LEN),
    })
    .strict();

  constructor(
    private readonly agentHome: string,
    private readonly workspaceRoot: string,
  ) {}

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    const { target, content } = this.inputSchema.parse(arguments_);
    const file = target === "user" ? "USER.md" : "PROJECT.md";
    const path = join(target === "user" ? this.agentHome : this.workspaceRoot, file);
    const body = content.endsWith("\n") ? content : `${content}\n`;
    await writeFile(path, body, "utf8");
    return { ok: true, target, savedTo: file, bytes: Buffer.byteLength(body) };
  }
}
