import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { TUTOR_SOUL } from "./agent/agentSouls";

const MODEL = "google/gemini-3.1-flash-lite";

/** Stable agent-home dir (same resolution the harness uses) where USER.md lives. */
export function agentHomeDir(): string {
  return process.env.PATHFORGE_AGENT_HOME?.trim() || join(tmpdir(), "pathforge-agent-home");
}

/**
 * The TUTOR maintains USER.md once per node: on node completion it reflects on the
 * node's conversation and rewrites its durable, project-agnostic notes about the
 * learner. Best-effort — never throws, so it can't block node completion.
 */
export async function updateUserDocFromNode(params: {
  nodeTitle: string;
  messages: { role: string; content: string }[];
  profileSummary?: string | null;
}): Promise<void> {
  try {
    const home = agentHomeDir();
    await mkdir(home, { recursive: true });
    const userPath = join(home, "USER.md");

    let current = "";
    try {
      current = await readFile(userPath, "utf8");
    } catch {
      // no USER.md yet — start fresh
    }

    const transcript = params.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(-6000);

    const prompt = `${TUTOR_SOUL}

You are updating USER.md — your durable notes about THIS learner that persist across every project and node. USER.md must contain ONLY stable, project-agnostic facts: their skill level, preferred language, how they like to be taught, and recurring strengths/struggles you have observed. Never put project-specific details, the current node, or transient chatter here.

Current USER.md:
"""
${current.trim() || "(empty)"}
"""

Onboarding profile summary: ${params.profileSummary?.trim() || "(none)"}

The learner just finished the node "${params.nodeTitle}". Its conversation:
"""
${transcript || "(no conversation on this node)"}
"""

Rewrite USER.md IN FULL: keep what still holds, fold in any new stable insight about the learner from this node, and stay concise (a short markdown doc, well under 300 words). Output ONLY the new USER.md markdown, no preamble or code fences.`;

    const res = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const next = res.choices[0]?.message?.content?.trim();
    if (next) {
      await writeFile(userPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    }
  } catch {
    // best-effort: a failed memory update must never break node completion
  }
}
