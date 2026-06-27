import { openrouter } from "@workspace/integrations-openrouter-ai";
import type { LearnerProfile, Node as DbNode, CodeFile } from "@workspace/db";

const MODEL = "google/gemini-3.1-flash-lite";

export type { CodeFile };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface MapContext {
  allNodes: { id: number; title: string; brief: string; status: string; summary?: string | null }[];
  allEdges: { fromNodeId: number; toNodeId: number }[];
}

function extractMinistepsFromHistory(history: ChatMessage[]): string[] {
  const opening = history.find((m) => m.role === "assistant");
  if (!opening) return [];
  const lines = opening.content.split("\n");
  const steps: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\d+\.\s+\S/.test(trimmed)) {
      steps.push(trimmed.replace(/^\d+\.\s+/, ""));
      inBlock = true;
    } else if (inBlock && trimmed !== "") {
      break;
    }
  }
  return steps.length >= 2 ? steps : [];
}

function buildProfileContext(profile: LearnerProfile | null): string {
  if (!profile) return "No profile — assume intermediate level.";
  return [
    profile.age ? `Age: ${profile.age}` : null,
    profile.educationLevel ? `Education: ${profile.educationLevel}` : null,
    profile.major ? `Field/Major: ${profile.major}` : null,
    profile.interests ? `Interests: ${profile.interests}` : null,
    profile.experience ? `Experience: ${profile.experience}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCodeContextSection(files: CodeFile[]): string {
  if (files.length === 0) return "No code written yet — this is the start of the project.";
  return files.map((f) => {
    const lastChanges = f.changeLog.slice(-3).map((c) => `  • ${c.note} (${c.reason})`).join("\n");
    return `**${f.filename}** — ${f.description}\nRecent changes:\n${lastChanges || "  • (initial version)"}\n\`\`\`\n${f.content.slice(0, 1200)}${f.content.length > 1200 ? "\n... (truncated)" : ""}\n\`\`\``;
  }).join("\n\n");
}

function buildSuccessorSection(nodeId: number, mapCtx: MapContext): string {
  const successorIds = mapCtx.allEdges
    .filter((e) => e.fromNodeId === nodeId)
    .map((e) => e.toNodeId);
  const successors = successorIds
    .map((id) => mapCtx.allNodes.find((n) => n.id === id))
    .filter(Boolean) as MapContext["allNodes"];
  if (successors.length === 0) return "This is the final node — no further steps after this.";
  return successors.map((n) => `- **${n.title}**: ${n.brief}`).join("\n");
}

function buildRichSystemPrompt(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  mapCtx: MapContext,
  recentConcerns: string[],
  codeFiles: CodeFile[],
  history?: ChatMessage[],
  completedStepIndices?: number[]
): string {
  const profileContext = buildProfileContext(profile);

  const completedNodes = mapCtx.allNodes.filter((n) => n.status === "completed");
  const completedSummaries =
    completedNodes.length > 0
      ? completedNodes
          .map((n) => `- **${n.title}**: ${n.summary ?? n.brief}`)
          .join("\n")
      : "None yet — this is the first node.";

  const mapOverview = mapCtx.allNodes
    .map((n) => {
      const marker = n.status === "completed" ? "✓" : n.status === "available" ? "→" : "○";
      return `${marker} ${n.title}: ${n.brief}`;
    })
    .join("\n");

  const recentConcernsText =
    recentConcerns.length > 0
      ? recentConcerns.map((c) => `- ${c}`).join("\n")
      : "No recent concerns noted.";

  const codeContextSection = buildCodeContextSection(codeFiles);
  const successorSection = buildSuccessorSection(node.id, mapCtx);

  const ministeps = history ? extractMinistepsFromHistory(history) : [];
  const done = new Set(completedStepIndices ?? []);
  const checklistSection = ministeps.length >= 2
    ? `\n## Session Checklist\nMini-steps for this session (✓ = done, ○ = pending):\n${ministeps.map((s, i) => `${done.has(i) ? "✓" : "○"} ${i + 1}. ${s}`).join("\n")}\n\nTracking rule: when the learner has COMPLETED a pending step — they've implemented it, run it, and confirmed it works — append \`[STEP_DONE:N]\` at the very end of your response (N = 1-based step number). You may mark multiple: \`[STEP_DONE:1][STEP_DONE:2]\`. Never mark a step done just because you explained it. Steps already marked ✓ are done — do not re-mark them.\n`
    : "";

  return `You are a personalized AI tutor for the learning topic: "${node.title}".

## Project Context
The learner is building: "${project.title}"
Description: ${project.ideaPrompt}

## Learner Profile
${profileContext}

## Current Node
Title: ${node.title}
Overview: ${node.brief}

## What Comes Next (nodes unlocked after this one)
${successorSection}

## Learning Progress
### Completed nodes (with summaries):
${completedSummaries}

### Full map overview (✓=completed, →=available, ○=locked):
${mapOverview}

### Recent learner concerns (from latest conversations):
${recentConcernsText}

## Current Project Code State
${codeContextSection}
${checklistSection}
## Your Role
1. Teach "${node.title}" at the exact level of this learner — NEVER explain things they already know.
   - If they have years of Python/C experience: skip syntax basics, variable types, loops, functions, I/O — assume mastery.
   - If they mention ROS2/robotics experience: treat it as prior knowledge and build on it directly.
   - Only revisit fundamentals if the learner explicitly asks or is clearly confused.

2. Calibrate response length to the question:
   - Direct/short questions → direct, concise answers (no padding).
   - "Explain how X works" questions → structured breakdown with headers or bullets.
   - Never add filler phrases ("Great question!", "Certainly!", "Let me explain...").

3. Guide, don't just solve:
   - When the learner is stuck or asks for the answer, give a hint or ask a leading question first.
   - Only reveal the full solution if they've made a genuine attempt or explicitly ask after a hint.
   - When they make a mistake in code, point to the specific line and ask them to reason through it before fixing it for them.

4. Adapt to pacing signals:
   - If the learner is confused or asking repeated clarifying questions → slow down, simplify, use an analogy.
   - If the learner is breezing through or already knows the answer → skip the basics, jump ahead, challenge them.

5. ALWAYS build on the existing code above — do NOT rewrite from scratch.
   - Reference files by name (e.g. "In \`calculator.py\`, modify the \`build_ui()\` function to...").
   - Show only the specific lines/functions to add or change, not the entire file.
   - Explain what to remove/replace and why.
   - If the learner pastes their own code that differs from the stored version, treat THEIR version as the ground truth.

6. All code examples must use "${project.title}"'s actual context — the project's domain, filenames, and variable names, not generic placeholders like "foo" or "my_app".

7. Keep the "What Comes Next" nodes in mind — prepare the learner for those topics without doing the work for them.

8. Share practical tips, gotchas, and performance considerations that experienced developers care about.

9. Suggest adding a new node only when the learner raises a clearly distinct topic not covered anywhere in the map.

10. Suggest marking this node complete only when the learner has demonstrated understanding: they've explained the concept back, produced working code, or completed the node's stated outcome. Don't rush them.

11. Use markdown for code (with proper language tags), bullet lists, and bold key terms.

12. Tone: direct and technical, like a senior developer pair-programming with the learner. No cheerleading.`;
}

export async function extractCodeContextUpdates(
  nodeTitle: string,
  project: { title: string },
  userMessage: string,
  assistantResponse: string,
  existingFiles: CodeFile[]
): Promise<Array<{ filename: string; isNew: boolean; content: string; description?: string; changeNote: string; reason: string }>> {
  // Only bother if the response actually contains code blocks
  if (!assistantResponse.includes("```")) return [];

  const existingSummary = existingFiles.length === 0
    ? "No files yet."
    : existingFiles.map((f) => `- ${f.filename}: ${f.description}`).join("\n");

  const prompt = `You are extracting code file changes from an AI tutor response.

Project: "${project.title}"
Current topic: "${nodeTitle}"
Existing tracked files:
${existingSummary}

Learner asked: "${userMessage.slice(0, 300)}"

Tutor responded (excerpt):
${assistantResponse.slice(0, 3500)}

Task: Identify code files that were created or modified in this response.
- For EVERY file mentioned (new or changed): provide the filename, the COMPLETE FINAL code content as shown in the response, a short changeNote (max 15 words), and reason (max 10 words).
- isNew=true if the file didn't exist before, isNew=false if it's a modification.
- If the response only explains concepts without producing file-level code, return empty updates.

IMPORTANT: Always include the full code content — this is how we track the current state of the project.

Respond ONLY with valid JSON, no markdown:
{"updates": [{"filename": "app.py", "isNew": false, "content": "# full file content here...", "description": "Main app", "changeNote": "added while True loop with quit", "reason": "user input loop"}]}
OR
{"updates": []}`;

  try {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    const content = response.choices[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content) as { updates: Array<{ filename: string; isNew: boolean; content: string; description?: string; changeNote: string; reason: string }> };
    return parsed.updates ?? [];
  } catch {
    return [];
  }
}

export function applyCodeContextUpdates(
  existingFiles: CodeFile[],
  updates: Array<{ filename: string; isNew: boolean; content: string; description?: string; changeNote: string; reason: string }>
): CodeFile[] {
  const files = [...existingFiles];
  for (const update of updates) {
    if (!update.content) continue;
    const existing = files.findIndex((f) => f.filename === update.filename);
    const logEntry = { note: update.changeNote, reason: update.reason, timestamp: new Date().toISOString() };
    if (existing >= 0) {
      // Always update content to keep it current
      files[existing] = {
        ...files[existing],
        content: update.content,
        changeLog: [...files[existing].changeLog, logEntry],
      };
    } else {
      files.push({
        filename: update.filename,
        description: update.description ?? update.filename,
        content: update.content,
        changeLog: [logEntry],
      });
    }
  }
  return files;
}

export async function* streamNodeChatMessage(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  history: ChatMessage[],
  userMessage: string,
  mapCtx: MapContext,
  recentConcerns: string[],
  codeFiles: CodeFile[],
  completedStepIndices: number[] = []
): AsyncGenerator<string> {
  const systemPrompt = buildRichSystemPrompt(node, project, profile, mapCtx, recentConcerns, codeFiles, history, completedStepIndices);

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: userMessage },
  ];

  const stream = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 16384,
    messages,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      yield delta;
    }
  }
}

export async function* streamOpeningMessage(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  mapCtx: MapContext,
  recentConcerns: string[],
  codeFiles: CodeFile[]
): AsyncGenerator<string> {
  const systemPrompt = buildRichSystemPrompt(node, project, profile, mapCtx, recentConcerns, codeFiles);

  const hasCode = codeFiles.length > 0;
  const userPrompt = hasCode
    ? `[Opening message for node: "${node.title}"]
Generate a tutor opening message that:
1. In 1–2 sentences, states what this session covers end-to-end.
2. Lists ALL the mini-steps for this session as a numbered list. For each step, write the step title followed by a dash and 1–3 sentences explaining exactly what the learner will do and why — be concrete (mention specific commands, filenames, or functions). Example format:
   1. Step title — What you'll do, why it matters, and any key detail or command.
   2. Step title — Specific action with the exact tool/command/file involved.
3. Names the file(s) involved across the steps.
4. Then asks: "Does your current code match what's shown above, or have you made changes? Paste your version if it differs — then we'll start on step 1."
`
    : `[Opening message for node: "${node.title}"]
Generate a tutor opening message that:
1. In 1–2 sentences, states what this session covers end-to-end.
2. Lists ALL the mini-steps for this session as a numbered list. For each step, write the step title followed by a dash and 1–3 sentences explaining exactly what the learner will do and why — be concrete (mention specific commands, filenames, or functions). Example format:
   1. Step title — What you'll do, why it matters, and any key detail or command.
   2. Step title — Specific action with the exact tool/command/file involved.
3. Ends with: "Let's start with step 1." and immediately gives the first concrete action.
`;

  const stream = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 8192,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      yield delta;
    }
  }
}

interface ExtraNodeClassification {
  needed: boolean;
  topic?: string;
  reason?: string;
}

export async function classifyExtraNodeNeeded(
  node: DbNode,
  userMessage: string,
  assistantResponse: string,
  mapCtx: MapContext
): Promise<ExtraNodeClassification> {
  const existingTitles = mapCtx.allNodes.map((n) => n.title).join(", ");

  const prompt = `You are evaluating a tutoring conversation to decide if a new "extra" learning node should be created.

Current node: "${node.title}" — ${node.brief}
Existing nodes in the map: ${existingTitles}

Learner said: "${userMessage}"
Tutor responded: "${assistantResponse.slice(0, 500)}..."

Decide: Does the learner's message raise a distinct topic that:
1. Is NOT already covered by any existing node in the map
2. Would benefit from its own dedicated learning step
3. Is specific enough to be a standalone 15-minute learning topic

If yes, specify a concise topic title (max 8 words).

Respond ONLY with valid JSON, no markdown:
{"needed": true, "topic": "Specific Topic Title", "reason": "brief reason"} 
OR
{"needed": false}`;

  try {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    const content = response.choices[0]?.message?.content;
    if (!content) return { needed: false };
    return JSON.parse(content) as ExtraNodeClassification;
  } catch {
    return { needed: false };
  }
}

export async function generateNodeSummary(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  chatHistory: ChatMessage[]
): Promise<string> {
  const conversationSample = chatHistory
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Learner" : "Tutor"}: ${m.content.slice(0, 300)}`)
    .join("\n");

  const prompt = `Based on this node's content and learning conversation, write a ONE-LINE summary (max 15 words) of what was learned.

Node: "${node.title}" — ${node.brief}
Project: "${project.title}"

Recent conversation:
${conversationSample}

Write a crisp one-liner summary of the key takeaway or skill gained. Start with a verb. No quotes.`;

  try {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    });
    const content = response.choices[0]?.message?.content?.trim();
    return content ?? `Learned ${node.title}`;
  } catch {
    return `Completed ${node.title}`;
  }
}

interface SpawnedNode {
  title: string;
  brief: string;
}

export async function generateSpawnedNode(
  parentNode: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  topic: string
): Promise<SpawnedNode> {
  const profileContext = buildProfileContext(profile);

  const prompt = `You are designing a single extra learning node for a curriculum.

Main project: "${project.title}" — ${project.ideaPrompt}
Parent node: "${parentNode.title}" — ${parentNode.brief}
Learner profile: ${profileContext}
Requested topic: "${topic}"

Generate ONE extra learning node that:
- Dives deeper into the requested topic in the context of the parent node and project
- Has a short title (max 8 words) and a 1-2 sentence brief description
- Is appropriately scoped (not too broad, not too narrow)
- Is tailored to the learner's level

Respond ONLY with valid JSON, no markdown:
{"title": "...", "brief": "..."}`;

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty AI response for spawn");

  const parsed = JSON.parse(content) as SpawnedNode;
  if (!parsed.title || !parsed.brief) throw new Error("Invalid spawned node shape");

  return parsed;
}

interface RevisedNode {
  id: string;
  title: string;
  brief: string;
  prerequisite_ids: string[];
}

interface RevisePlanResult {
  revised_nodes: RevisedNode[];
}

export async function revisePlanNodes(
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  currentNodes: { id: number; title: string; brief: string; status: string }[],
  currentEdges: { fromNodeId: number; toNodeId: number }[],
  description: string
): Promise<RevisePlanResult> {
  const profileContext = buildProfileContext(profile);

  const completedNodes = currentNodes
    .filter((n) => n.status === "completed")
    .map((n) => `[DONE] n${n.id}: ${n.title}`)
    .join("\n");

  const futureNodes = currentNodes
    .filter((n) => n.status !== "completed")
    .map((n) => `[${n.status.toUpperCase()}] n${n.id}: ${n.title} — ${n.brief}`)
    .join("\n");

  const edgeList = currentEdges
    .map((e) => `n${e.fromNodeId} → n${e.toNodeId}`)
    .join(", ");

  const prompt = `You are revising a learning curriculum for a project-based learner.

Project: "${project.title}" — ${project.ideaPrompt}
Learner: ${profileContext}

## Completed nodes (DO NOT change these):
${completedNodes || "None"}

## Future nodes to potentially revise (available + locked):
${futureNodes}

## Current edges (prerequisite relationships):
${edgeList || "None"}

## Learner's requested change:
"${description}"

Revise the future nodes to better match this direction. Rules:
1. Keep completed nodes exactly as-is (don't include them in your output).
2. You may update, remove, or add future nodes to match the new direction.
3. Keep the same node IDs where possible (reuse them if the node concept is retained).
4. Add new nodes with new IDs like "new1", "new2", etc.
5. Maintain a coherent prerequisite graph (DAG, no cycles).
6. Use as many future nodes as the remaining project scope genuinely requires — don't artificially compress or pad. Small remaining scope may need only 2–4 future nodes; a large pivot may need 15+.
7. Nodes should still lead toward the same final project goal.
8. Each node brief must describe a concrete outcome — what the learner will build or demonstrate, not just "understand".
9. SKIP topics the learner already knows based on their profile — do not add nodes for things they've stated as prior knowledge.
10. Treat explicit sequencing in the learner's requested change as authoritative for all future nodes.
11. Do not put validation/checkpoint work before the design/build/provisioning work it validates. Docker, deployment, test, benchmark, or UAT nodes should be downstream integration checkpoints unless the learner explicitly says they are validating an already-existing system.
12. For rebuild, migration, audit, or "recreate from existing project" work, future nodes should begin with source documentation/code analysis and architecture extraction before scaffold, implementation, provisioning, workflow import, or infrastructure validation.
13. If completed nodes are semantically out of order, preserve them as completed historical evidence, but make the remaining path explicitly correct. Do not make future nodes depend on a completed checkpoint that the learner says should have occurred later.
14. Do not create duplicate or near-duplicate future nodes. If two future nodes cover the same outcome (for example provisioning/configuring NocoDB, importing/activating n8n, wiring n8n workflow logic, refactoring, deployment readiness, testing, or documentation), consolidate them into one node and reuse the most appropriate existing node ID.
15. When aligning with a real implementation, remove future nodes whose work is already represented by completed nodes or completed external evidence, unless they are explicitly about final audit or verification.

Respond ONLY with valid JSON, no markdown:
{
  "revised_nodes": [
    {"id": "n5", "title": "...", "brief": "...", "prerequisite_ids": ["n3", "n4"]},
    {"id": "new1", "title": "...", "brief": "...", "prerequisite_ids": ["n5"]}
  ]
}`;

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty AI response for revise plan");

  const parsed = JSON.parse(content) as RevisePlanResult;
  if (!parsed.revised_nodes || !Array.isArray(parsed.revised_nodes)) {
    throw new Error("Invalid revise plan response shape");
  }

  return parsed;
}
