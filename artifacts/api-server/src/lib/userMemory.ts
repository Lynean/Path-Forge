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

function significantTitleTerms(value: string | undefined): string[] {
  return (value?.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(
    (term) => term.length >= 4 && !["project", "node", "step"].includes(term),
  );
}

export function sanitizeUserMemoryMarkdown(
  markdown: string,
  context: { projectTitle?: string; nodeTitle?: string; profileSummary?: string | null } = {},
): string {
  const forbiddenTerms = new Set([
    ...significantTitleTerms(context.projectTitle),
    ...significantTitleTerms(context.nodeTitle),
  ]);
  const profileText = context.profileSummary?.toLowerCase() ?? "";
  const lines = markdown.replace(/```[\s\S]*?```/g, "").split(/\r?\n/);
  const kept: string[] = [];
  let insideTransientSection = false;
  for (const line of lines) {
    const normalized = line.trim().toLowerCase();
    const isHeading = /^#{1,6}\s+/.test(normalized);
    if (
      /^(?:#+\s*)?(?:current|recent)\s+(?:focus|project|node|task|work)\b/.test(normalized) ||
      /\b(?:this|the current)\s+(?:project|node|step|task)\b/.test(normalized)
    ) {
      if (isHeading) insideTransientSection = true;
      continue;
    }
    if (isHeading) insideTransientSection = false;
    if (insideTransientSection) continue;
    if (!normalized) {
      kept.push(line);
      continue;
    }
    if (
      [...forbiddenTerms].some((term) => normalized.includes(term)) &&
      !profileText.includes([...forbiddenTerms].find((term) => normalized.includes(term)) ?? "")
    ) {
      continue;
    }
    // A language preference is durable only when onboarding explicitly supplied
    // it; do not infer "prefers Python" merely from one Python project.
    if (
      /\bpreferred language\b/.test(normalized) &&
      !/\bpreferred language\b/.test(profileText)
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The TUTOR maintains USER.md once per node: on node completion it reflects on the
 * node's conversation and rewrites its durable, project-agnostic notes about the
 * learner. Best-effort — never throws, so it can't block node completion.
 */
export async function updateUserDocFromNode(params: {
  nodeTitle: string;
  projectTitle?: string;
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

    current = sanitizeUserMemoryMarkdown(current, params);

    // Learner-authored text is the only behavioral evidence. Assistant prose,
    // tool output, code blocks, and injected step context must not become claims
    // about the learner.
    const transcript = params.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content.replace(/```[\s\S]*?```/g, "[code omitted]"))
      .map((content) => `learner: ${content}`)
      .join("\n")
      .slice(-6000);

    const prompt = `${TUTOR_SOUL}

You are updating USER.md — durable notes about THIS learner that persist across every project. USER.md may contain ONLY facts the learner explicitly stated about their age/level, preferred teaching style, accessibility needs, or stable preferences. Do not infer a preferred language from the current codebase. Do not infer strengths or struggles from a single task, deliberate test bug, or assistant-authored explanation. Never include a current focus, technology, filename, function, project, node, step, or transient debugging event.

Current USER.md:
"""
${current.trim() || "(empty)"}
"""

Onboarding profile summary: ${params.profileSummary?.trim() || "(none)"}

Learner-authored messages from the latest session (project/code details are evidence to ignore, not memory to store):
"""
${transcript || "(no conversation on this node)"}
"""

Rewrite USER.md IN FULL. Prefer omitting a field over guessing it. Keep it concise (well under 200 words). Output ONLY markdown, with no current-focus/project section, preamble, or code fences.`;

    const res = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const rawNext = res.choices[0]?.message?.content?.trim() ?? "";
    const next = sanitizeUserMemoryMarkdown(rawNext, params);
    if (next) {
      await writeFile(userPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    }
  } catch {
    // best-effort: a failed memory update must never break node completion
  }
}
