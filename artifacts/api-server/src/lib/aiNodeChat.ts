import { openrouter } from "@workspace/integrations-openrouter-ai";
import type { LearnerProfile, Node as DbNode, CodeFile } from "@workspace/db";

const MODEL = "google/gemini-3.1-flash-lite";

export type { CodeFile };

/**
 * Wraps a chat-completion stream and yields its content deltas, but throws if the
 * stream ends for any reason other than a clean "stop" (e.g. "length" — hit max_tokens
 * mid-generation). Without this, a truncated response — a dangling [STEP_UPDATE:N] with
 * no closing tag, a cut-off command mid-line — would otherwise be treated as a normal,
 * complete response: persisted to chat history and shown to the learner as-is. The
 * caller's error handling (SSE error event, no DB write) takes over from the throw.
 */
async function* consumeCompletionStream(
  stream: AsyncIterable<{ choices: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }> }>
): AsyncGenerator<string> {
  let finishReason: string | null = null;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
    const fr = chunk.choices[0]?.finish_reason;
    if (fr) finishReason = fr;
  }
  if (finishReason && finishReason !== "stop") {
    throw new Error(`AI response was cut off (${finishReason}) before finishing — please try again.`);
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface MapContext {
  allNodes: { id: number; title: string; brief: string; status: string; summary?: string | null }[];
  allEdges: { fromNodeId: number; toNodeId: number }[];
}

// The opening message encodes the session plan as `[SLIDE:intro]...[SLIDE:1]...[SLIDE:2]...`.
function extractMinistepsFromHistory(history: ChatMessage[]): string[] {
  const opening = history.find((m) => m.role === "assistant" && m.content.includes("[SLIDE:"));
  if (!opening) return [];
  const parts = opening.content.split(/\[SLIDE:(\w+)\]/);
  const steps: string[] = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    const key = parts[i].trim();
    if (key === "intro") continue;
    const body = parts[i + 1].trim();
    if (!body) continue;
    const titleMatch = body.match(/^\*\*([^*]+)\*\*/);
    steps.push(titleMatch ? titleMatch[1].trim() : body.split("\n")[0].slice(0, 60));
  }
  return steps.length >= 2 ? steps : [];
}

function isInternalHistoryMessage(m: ChatMessage): boolean {
  return m.role === "assistant" && (/^\[STEP_DETAIL:\d+\]/.test(m.content) || m.content.startsWith("[EXTRA_REDIRECT:"));
}

/**
 * The raw messages array persisted per node mixes real conversation turns with internal
 * bookkeeping entries — cached step-detail walkthroughs (can run thousands of tokens
 * each) and node-redirect notices. Neither is something the tutor actually "said" in
 * conversation; sending them to the model as chat turns wastes context budget and
 * confuses the model with formatting it never spoke aloud. The opening message itself
 * (the `[SLIDE:...]` plan) is kept but replaced with a short pointer, since its content
 * is already surfaced via the Session Checklist section built from it.
 */
function cleanChatHistory(history: ChatMessage[]): ChatMessage[] {
  return history
    .filter((m) => !isInternalHistoryMessage(m))
    .map((m) =>
      m.role === "assistant" && m.content.includes("[SLIDE:")
        ? { ...m, content: "(Opening session plan for this node — see the Session Checklist above for the step list.)" }
        : m
    );
}

const HISTORY_WINDOW_SIZE = 16; // keep roughly the last 8 turns verbatim

/**
 * Chat sessions can run long, and the full history was previously resent on every turn —
 * unbounded prompt growth that increases cost/latency and raises the risk of hitting the
 * output token limit mid-generation. This keeps the most recent messages verbatim
 * (recency matters most for a direct reply) and condenses anything older into one short
 * AI-written summary instead of resending it in full every single turn.
 */
async function condenseHistoryForModel(
  cleanedHistory: ChatMessage[]
): Promise<{ recentHistory: ChatMessage[]; olderSummary: string | null }> {
  if (cleanedHistory.length <= HISTORY_WINDOW_SIZE) {
    return { recentHistory: cleanedHistory, olderSummary: null };
  }

  const older = cleanedHistory.slice(0, -HISTORY_WINDOW_SIZE);
  const recentHistory = cleanedHistory.slice(-HISTORY_WINDOW_SIZE);

  const transcript = older
    .map((m) => `${m.role === "user" ? "Learner" : "Tutor"}: ${m.content.slice(0, 400)}`)
    .join("\n\n");

  const prompt = `Summarize the following earlier portion of a tutoring conversation in one short paragraph (5-8 sentences). Preserve concrete facts, corrections, and decisions established, and what was already covered — this summary replaces the raw messages as context for continuing the conversation, so don't lose anything a continuation would need.

${transcript}

Respond with ONLY the summary paragraph, no preamble.`;

  try {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const olderSummary = response.choices[0]?.message?.content?.trim() || null;
    return { recentHistory, olderSummary };
  } catch {
    // Summarization failing shouldn't fail the whole chat turn — losing the oldest
    // context is better than losing the reply entirely.
    return { recentHistory, olderSummary: null };
  }
}

function buildProfileContext(profile: LearnerProfile | null): string {
  if (!profile) return "No profile — assume intermediate level.";
  return [
    profile.age ? `Age: ${profile.age}` : null,
    profile.educationLevel ? `Education: ${profile.educationLevel}` : null,
    profile.major ? `Field/Major: ${profile.major}` : null,
    profile.profileSummary ? profile.profileSummary : null,
    profile.preferredLanguage ? `Preferred language: ${profile.preferredLanguage}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function getLanguageInstruction(profile: LearnerProfile | null): string {
  const lang = profile?.preferredLanguage;
  if (!lang || lang === "English") return "";
  return `\nIMPORTANT: Respond entirely in ${lang}. Code, variable names, and technical terms may stay in English, but all explanations, questions, and prose must be in ${lang}.`;
}

function buildCodeContextSection(files: CodeFile[]): string {
  if (files.length === 0) return "No code written yet — this is the start of the project.";
  return files.map((f) => {
    const lastChanges = f.changeLog.slice(-3).map((c) => `  • ${c.note} (${c.reason})`).join("\n");
    return `**${f.filename}** — ${f.description}\nRecent changes:\n${lastChanges || "  • (initial version)"}\n\`\`\`\n${f.content.slice(0, 1200)}${f.content.length > 1200 ? "\n... (truncated)" : ""}\n\`\`\``;
  }).join("\n\n");
}

type ProjectType =
  | "algorithm"
  | "math-impl"
  | "hardware"
  | "robotics"
  | "workflow-tools"
  | "cybersecurity"
  | "data-analytics"
  | "enterprise-integration"
  | "document-heavy"
  | "theory";

function detectProjectTypes(text: string): ProjectType[] {
  const t = text.toLowerCase();
  const found: ProjectType[] = [];
  if (/\b(leetcode|codeforces|hackerrank|competitive programming|algorithm challenge|olympiad)\b/.test(t)) found.push("algorithm");
  if (/\b(deep learning|machine learning|neural network|gradient|backprop|pytorch|tensorflow|keras|training loop|loss curve|epoch|llm|transformer|fine.tun)\b/.test(t)) found.push("math-impl");
  if (/\b(arduino|raspberry pi|esp32|esp8266|\biot\b|embedded|microcontroller|servo|stepper motor|sensor|i2c|spi\b|uart|gpio|pwm|datasheet)\b/.test(t)) found.push("hardware");
  if (/\b(ros2?|webots|gazebo|simulink|urdf|lidar|slam|odometry|ros node|ros topic|robotic)\b/.test(t)) found.push("robotics");
  if (/\b(n8n|zapier|airtable|excel|google sheets|\bsas\b|power bi|figma|tableau|workflow builder|spreadsheet|pivot table|make\.com)\b/.test(t)) found.push("workflow-tools");
  if (/\b(pentest|penetration test|ctf|capture the flag|nmap|burp|metasploit|vulnerability|exploit|hardening|oscp|owasp|security audit|cybersecurity|cyber security)\b/.test(t)) found.push("cybersecurity");
  if (/\b(data anal|analytics|pandas|jupyter|ggplot|sql quer|statistics|data clean|data science|\.csv|data pipeline|bi dashboard)\b/.test(t)) found.push("data-analytics");
  if (/\b(enterprise integrat|corporate ai|ibm.*agent|multi.agent system|api integrat|low.code|no.code|power automate)\b/.test(t)) found.push("enterprise-integration");
  if (/\b(datasheet|reference manual|\brfc\b|whitepaper|technical manual)\b/.test(t)) found.push("document-heavy");
  if (/\b(proof\b|theorem|calculus|linear algebra|probability theory|discrete math|number theory|abstract algebra)\b/.test(t)) found.push("theory");
  return found;
}

function buildContextSyncSection(types: ProjectType[]): string {
  const has = (...t: ProjectType[]) => t.some((x) => types.includes(x));
  const sections: string[] = [];

  sections.push(`## What You Can and Cannot See — Context Sync Guide
You only know what the learner explicitly shares. Rule: never ask for something already in the code state above. If you need context, ask for exactly one specific thing — a targeted log line, formula, scan output, or observation.`);

  sections.push(`**Code projects**: The tracked code state above is your ground truth. Build on it directly.${has("algorithm") ? " For competitive programming: ask for the learner's current attempt and any failing test case before giving hints." : ""}`);

  if (has("math-impl", "robotics", "enterprise-integration") || types.length === 0) {
    sections.push(`**Code + invisible runtime**: You can see code but NOT terminal output, training logs, ROS topic data, browser rendering, or API responses. When diagnosing, ask for the specific output you need — e.g. "paste the last 20 lines of your training log", "what does \`ros2 topic echo /cmd_vel\` print?", "paste the full stack trace".`);
  }

  if (has("workflow-tools", "data-analytics")) {
    sections.push(`**Visual/GUI-driven systems** (Excel, n8n, SAS, Power BI, Figma): You cannot see the UI or canvas. Ask the learner to export to a readable format (CSV snippet, workflow JSON, SAS log) or paste specific values, formulas, and settings.`);
  }

  if (has("hardware", "cybersecurity")) {
    sections.push(`**Physical/hardware systems**: You cannot observe wiring, sensor readings, or live system state. Give the learner a concrete checklist to check/measure/observe, then interpret what they report.${has("cybersecurity") ? " For security: guide the learner to run specific commands (nmap, netstat, openssl, Wireshark) and share the output — teach interpretation, not just tool syntax." : ""}${has("hardware") ? " For hardware: ask for serial monitor output and what actuators/LEDs are doing; teach the learner to read the relevant datasheet sections themselves." : ""}`);
  }

  if (has("document-heavy", "hardware")) {
    sections.push(`**Document-heavy work** (datasheets, manuals, papers): You cannot access these unless the learner pastes a section. Teach navigation — which section to open, what term to search, what table/diagram to read — then interpret the excerpt together.`);
  }

  if (has("robotics", "hardware")) {
    sections.push(`**Observability-limited systems** (simulation, hardware-in-the-loop): You see code but not what the simulation or hardware is doing. Ask the learner to describe observed behavior (robot motion, sensor values, error states) and treat their description as your sensor data.`);
  }

  return sections.join("\n\n");
}

function buildTeachingApproachSection(types: ProjectType[]): string {
  if (types.length === 0) return "";

  const blocks: string[] = ["## Teaching Approach\nApply the approach(es) that fit this project — they are not mutually exclusive."];

  if (types.includes("algorithm")) blocks.push(`**Algorithm / Problem-solving**: Walk through a concrete example by hand before any code. Always ask "what's the brute force?" before the optimal approach. Focus on pattern recognition (sliding window, DP state, graph traversal), then complexity — time AND space. Never give the solution; give the key insight that unlocks it. Completion: passes all test cases AND learner can articulate time/space complexity and why the approach works.`);

  if (types.includes("math-impl")) blocks.push(`**Math + Implementation**: Dual track — intuition for the math first (what does this gradient mean geometrically?), then connect it to the code line that computes it. Don't skip the math for experienced coders — understanding WHY is the goal. Ground abstract formulas in tiny concrete examples (3×3 matrix, 5-sample dataset). Completion: learner can explain both what the code does and why the underlying math makes it work.`);

  if (types.includes("hardware")) blocks.push(`**Hardware / Embedded**: Connect every code line to a physical effect — "this sets pin 9 to PWM at 50% duty, driving the servo to ~90°." Teach datasheet reading as a first-class skill: pin assignment table, voltage/current limits, timing diagram, I2C/SPI register map — ask the learner to find the spec themselves before telling them. Think in hardware failure modes: floating pins, power draw, timing violations, voltage mismatch. Completion: observed physical behavior (serial monitor, LED state, sensor reading) matches expected — not just "compiles."`);

  if (types.includes("robotics")) blocks.push(`**Robotics / Simulation**: Teach the computation graph as the mental model — nodes, topics, services, actions, TF transforms, parameter server. Always flag the simulation-to-reality gap (latency, noise, physics approximations). Treat the learner's description of simulation behavior as sensor data. Completion: ROS node runs, expected topics publish correct data, learner can explain the data flow through the graph.`);

  if (types.includes("workflow-tools")) blocks.push(`**Visual / Workflow Tools**: Think in the tool's native mental model — cells/ranges for spreadsheets, nodes/edges for workflow builders, agents/channels for multi-agent systems. Reference UI elements by their exact names ("the HTTP Request node", "cell B3", "the PROC MEANS step"). Teach the tool's own debugging workflow (SAS log error codes, n8n execution log, Excel Evaluate Formula). Error handling and retry logic are non-optional — a workflow that silently fails is worse than one that doesn't run. Completion: tool produces correct output on realistic input and learner can trace why each step produces what it does.`);

  if (types.includes("cybersecurity")) blocks.push(`**Cybersecurity**: Frame every offensive technique alongside its defensive countermeasure. Follow methodology: reconnaissance → enumeration → vulnerability identification → exploitation (only if authorized) → evidence documentation → remediation. Teach tool output interpretation over tool syntax. Never provide weaponized payloads or evasion techniques for malicious use — explain vulnerability classes and impact. Completion: documented finding with evidence (command + output), impact assessment, and concrete remediation recommendation.`);

  if (types.includes("data-analytics")) blocks.push(`**Data Analytics**: Data quality before analysis — always address missing values, data types, outliers, and data source before computing anything. Connect every transformation to the business question it answers. Teach reproducibility: scripts over manual steps, documented assumptions, version-controlled notebooks. Completion: analysis is reproducible from raw data, assumptions are stated, results are interpretable by a non-technical reader.`);

  if (types.includes("enterprise-integration")) blocks.push(`**No-Code / Enterprise Integration**: Think in terms of data flow — what enters each node, what shape is it in, what leaves, what can fail. Treat exported JSON/YAML configs as source code. For AI integrations: prompt design, token limits, latency, cost per call, and failure fallbacks are engineering concerns, not afterthoughts. Completion: integration handles both the happy path AND at least one realistic failure case (API timeout, malformed input, empty response).`);

  if (types.includes("document-heavy")) blocks.push(`**Document-Heavy Work**: Document navigation IS the skill — teach how to find the right section, not just what the answer is. Identify the structure first (table of contents, register map, timing diagram, electrical characteristics table). Extract only what's needed — a datasheet is 200 pages; the learner needs three rows of a table. Teach cross-referencing: pin in the assignment table → same pin in schematic → same pin in example code.`);

  if (types.includes("theory")) blocks.push(`**Pure Theory / Math**: Use concrete small examples before generalizing. Push the learner to re-derive or re-explain the concept in their own words — passive reading is not learning. Connect theory to where it will appear in the practical project work ahead. Completion: learner can explain in their own words and apply to a novel example, not just recall the definition.`);

  return blocks.join("\n\n");
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
  completedStepIndices?: number[],
  olderHistorySummary?: string | null
): string {
  const profileContext = buildProfileContext(profile);
  const projectTypes = detectProjectTypes(`${project.title} ${project.ideaPrompt} ${node.title}`);
  const contextSyncSection = buildContextSyncSection(projectTypes);
  const teachingApproachSection = buildTeachingApproachSection(projectTypes);

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
    ? `\n## Session Checklist\nMini-steps for this session (✓ = done, ○ = pending):\n${ministeps.map((s, i) => `${done.has(i) ? "✓" : "○"} ${i + 1}. ${s}`).join("\n")}\n\nTracking rule: when the learner has COMPLETED a pending step — they've implemented it, run it, and confirmed it works — call the mark_steps_done tool (see below). Never mark a step done just because you explained it. Steps already marked ✓ are done — do not re-mark them.\n`
    : "";

  const olderHistorySection = olderHistorySummary
    ? `\n## Earlier in This Conversation (summarized — older messages, not shown verbatim below)\n${olderHistorySummary}\n`
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
${olderHistorySection}
${contextSyncSection}
${teachingApproachSection}

## Your Role
1. Teach "${node.title}" at the exact level of this learner — calibrate to their profile and never re-explain what they already know.
   - Experienced coders: skip language syntax, basic control flow, standard library basics — start from their knowledge boundary.
   - Domain experts (ROS2, robotics, SAS, security): treat stated experience as prior knowledge and build directly on top of it.
   - Only revisit fundamentals if the learner is clearly confused or explicitly asks.

2. Calibrate response length to the question:
   - Direct/short questions → direct, concise answers (no padding).
   - "Explain how X works" → structured breakdown with headers or bullets.
   - Never open with filler ("Great question!", "Certainly!", "Of course!").

3. Guide, don't just solve:
   - When stuck or asking for the answer: give a targeted hint or ask a leading question first.
   - Only reveal the full solution after a genuine attempt or an explicit request following a hint.
   - When the learner makes an error — in code, a formula, a circuit, a workflow — point to the specific location and ask them to reason through it before correcting it.

4. Adapt to pacing signals:
   - Confused or repeatedly asking clarifying questions → slow down, simplify, use a concrete analogy or small example.
   - Breezing through or already knows material → skip basics, raise the challenge, add depth.

5. Build on what exists — never restart from scratch unless explicitly asked.
   - Code: reference files by name, show only the specific lines/functions to change.
   - Formulas/workflows/configs: reference the specific cell, node, step, or parameter by name.
   - If the learner shares a version that differs from the tracked state above, treat THEIR version as ground truth.

6. All examples must use "${project.title}"'s actual context — real names, real domain terms, real filenames. No generic placeholders.

7. Keep "What Comes Next" in view — prepare the learner for upcoming nodes without doing that work prematurely.

8. Always surface the practical concern that practitioners actually care about for this project type:
   - Algorithm work: does it handle edge cases? what's the complexity?
   - Hardware: what are the voltage/current limits? what's the failure mode?
   - Security: what does the defender see? what's the remediation?
   - Data: is this reproducible? what assumptions did we make?
   - Workflow/integration: what happens when the API is down or returns garbage?
   - Simulation/robotics: will this hold on real hardware, or only in simulation?

9. Proactively mention version control (Git) when it would genuinely help the learner — don't force it, but don't wait to be asked either. Good triggers: the project has multiple files and is growing, the learner is about to make a risky change, they mention losing work or wanting to undo something, or the project involves collaboration. Skip it for single-file scripts, pure theory nodes, competitive programming, and Excel/no-code tools unless the learner is exporting configs as code. One short nudge is enough — "this is a good point to \`git commit\` before we refactor" — then move on. Don't derail the current lesson with a Git tutorial unless they ask for one.

10. **Tools vs. your text reply — use both together, each for its own job:**

Your text reply is always the conversational answer to the learner (or, if you're only taking action with nothing to answer, a short 1–2 sentence note on what you did and why). Never leave it empty. Call tools alongside it — in the same turn — whenever the situation genuinely calls for one:

- **update_step** — the learner asks to change one or more steps, a step is clearly wrong, OR you realize something YOU said earlier (a command, a fact, an approach) was incorrect or misleading and it affects how a step should be done. This includes recommending a different tool, language, framework, library, dataset, board/hardware, or environment than what a step originally assumed — e.g. you determine partway through the conversation that the learner's hardware can't run a required library, or their chosen tool/plan doesn't support something the step depends on. That is a self-correction just as much as a wrong fact, and it is NOT satisfied by just mentioning the change in your text reply. You do NOT write the step's new title/description yourself — pass stepNumber and a clear, specific reason (what changed and why, including any concrete new facts — the specific tool/board/file/approach now in play), and a dedicated backend pass writes the new title/brief from that reason plus the step's current content and the other steps in the plan, so the rewrite stays consistent with the rest of the session instead of depending on whatever else was in this chat turn. A vague reason produces a vague step — be as specific as you would be if you were writing the step yourself. Call it once per step that needs to change — never resend a step that's still correct, and never call it for steps that don't need changing. When you flag step N, also check the steps AFTER it: later steps often build on the same fact, file, directory, tool, or approach you're correcting, even if the learner's message only called out step N by name — a directory rename, tool swap, or corrected assumption at step N frequently still applies at step N+1, N+2, etc. Call update_step for each later step that's now wrong too, in the same turn, rather than assuming "the learner only asked about step N so the rest must be fine." The intro/overview is NOT a step — never target it with a stepNumber. If the step change also makes the session overview wrong or outdated, include introUpdate (written directly by you, in full) in that same update_step call to fix both together. Treat needing an introUpdate as a signal to look harder, not narrower: if the overview itself is wrong, the correction is usually project-wide, not confined to whichever step you were just discussing — re-check every step in the plan, not only the ones the learner explicitly mentioned, and call update_step for each one that's now wrong. There is no standalone way to edit only the intro — it's only ever updated alongside a step change (via introUpdate) or as part of regenerate_session.

- **regenerate_session** — RARE. Only when a foundational assumption changed broadly enough to likely affect MULTIPLE steps: environment/tooling swapped, a directory/naming convention changed, the project's architecture pivoted. For a single wrong step (with or without an overview tweak), use update_step instead — it's cheaper and more precise. You don't write the new intro or steps yourself here, just the reason — a dedicated backend pass rebuilds the entire plan (intro AND every step) reading the full conversation so far, so corrections and facts established anywhere in the chat carry through consistently everywhere they're relevant, not just patched into the intro while steps still silently reference old, wrong facts. Costly: every step's generated detail page is invalidated and regenerates next time the learner opens it.

- **add_steps** — you identify steps that are missing from the current session and should be appended.

- **spawn_node** — a distinct topic the learner raised that isn't covered anywhere in the existing map. The new node generates its own properly-sized opening session on its own, so don't worry about step count here. Call at most twice per response. When you spawn a node, keep your text reply to ONLY 1–2 sentences on *why* this deserves its own node — do NOT also answer the question in your text reply, since the full explanation belongs in the new node's opening session. Answering it here just duplicates what the new node is about to teach.

- **mark_steps_done** — the learner has COMPLETED a pending step from the session checklist below: implemented it, run it, and confirmed it works. Never call this just because you explained a step — only because the learner demonstrated it's done. Don't re-mark steps already shown as done.

11. Suggest marking this node complete only when the learner has met the node's stated outcome — working output, documented finding, explained concept, observed physical behavior — not just finished reading an explanation.

12. Use markdown for code (with proper language tags), formulas, bullet lists, and bold key terms. For hardware, use pin names and register values exactly as they appear in the datasheet.

13. Tone: direct and technical, like a senior practitioner actively working alongside the learner on their specific project. No cheerleading, no hedging, no unnecessary caveats.${getLanguageInstruction(profile)}`;
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

export interface ChatToolCall {
  name: "update_step" | "regenerate_session" | "add_steps" | "spawn_node" | "mark_steps_done";
  args: Record<string, unknown>;
}

const KNOWN_TOOL_NAMES = new Set<ChatToolCall["name"]>([
  "update_step", "regenerate_session", "add_steps", "spawn_node", "mark_steps_done",
]);

const CHAT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "update_step",
      description: "Flag a specific step as needing to change, with a clear reason — you do NOT write the new title/description yourself. Call this when the learner asks to change a step, a step is clearly wrong, or you're self-correcting something you said earlier that affects that step — including a different tool, language, framework, dataset, board/hardware, or environment than the step originally assumed. Mentioning the change in your text reply is not enough; the reason you give here drives a dedicated rewrite of the step's title/description, or the learner will later see a step that still teaches the old, wrong approach. When you flag one step, also check the steps AFTER it in the plan — they often build on the same fact/file/tool/approach even if the learner only asked about this one step, so call this tool again for each later step that's now wrong too. There is no separate tool for editing the intro/overview alone — if this step's change also makes the session overview text wrong or outdated (e.g. the overview mentions the same fact you're correcting), include introUpdate (written by you, in full) in this same call to fix both together; and if the overview itself needs updating, that's usually a sign the correction runs through most or all steps, not just this one — check every step, not only the ones already discussed.",
      parameters: {
        type: "object",
        properties: {
          stepNumber: { type: "integer", description: "1-based step number to replace, matching the numbering the learner sees (the intro/overview is not a step — use introUpdate for that, never a stepNumber)" },
          reason: { type: "string", description: "Specific explanation of what changed and why, including any concrete new facts (the specific tool/board/file/approach now in play) — this text is the ONLY input used to write the step's new title/description, so be as precise as you'd be if writing it yourself. A vague reason produces a vague step." },
          introUpdate: { type: "string", description: "Optional. Only include this if the session's overview/intro text also needs to change as a result of this step's update. Write the full replacement intro text yourself — this one IS authored directly by you, unlike the step title/description above. Omit entirely if the overview is still accurate." },
        },
        required: ["stepNumber", "reason"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "regenerate_session",
      description: "RARE. Rebuild the entire session plan (intro + every step) from scratch because a foundational assumption changed broadly enough to likely affect multiple steps: environment/tooling swapped, a directory/naming convention changed, the project's architecture pivoted. For a single wrong step, use update_step instead — it's cheaper and more precise.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "One sentence: what changed and why the whole plan needs rebuilding" },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_steps",
      description: "Append new steps to the end of the current session because you identified steps that are missing.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
              },
              required: ["title", "description"],
            },
          },
        },
        required: ["steps"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "spawn_node",
      description: "Create a new, separate learning node for a distinct topic the learner raised that isn't covered anywhere in the existing map. The new node generates its own properly-sized opening session on its own — don't worry about step count here. Call at most twice per response.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title, max 8 words" },
          brief: { type: "string", description: "1-2 sentence description" },
        },
        required: ["title", "brief"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mark_steps_done",
      description: "Mark one or more mini-steps from the Session Checklist as completed because the learner demonstrated they implemented, ran, and confirmed them working — not just because you explained them. Don't re-mark steps already shown as done.",
      parameters: {
        type: "object",
        properties: {
          stepNumbers: {
            type: "array",
            items: { type: "integer" },
            description: "1-based step numbers to mark done",
          },
        },
        required: ["stepNumbers"],
      },
    },
  },
];

interface RawToolCallAccumulator {
  name: string;
  argsText: string;
}

/**
 * Like consumeCompletionStream, but also accumulates streamed tool-call deltas (OpenAI
 * streams these incrementally too — name arrives once, arguments arrive in fragments
 * keyed by index) and returns the fully-parsed calls as the generator's return value once
 * the stream ends. Still throws on a non-clean finish, but "tool_calls" is a valid clean
 * finish alongside "stop".
 */
async function* consumeCompletionStreamWithTools(
  stream: AsyncIterable<{
    choices: Array<{
      delta?: {
        content?: string | null;
        tool_calls?: Array<{ index: number; function?: { name?: string; arguments?: string } }> | null;
      };
      finish_reason?: string | null;
    }>;
  }>
): AsyncGenerator<string, ChatToolCall[], void> {
  const accumulator = new Map<number, RawToolCallAccumulator>();
  let finishReason: string | null = null;

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta?.content;
    if (delta) yield delta;

    for (const tc of choice?.delta?.tool_calls ?? []) {
      const existing = accumulator.get(tc.index) ?? { name: "", argsText: "" };
      if (tc.function?.name) existing.name += tc.function.name;
      if (tc.function?.arguments) existing.argsText += tc.function.arguments;
      accumulator.set(tc.index, existing);
    }

    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }

  if (finishReason && finishReason !== "stop" && finishReason !== "tool_calls") {
    throw new Error(`AI response was cut off (${finishReason}) before finishing — please try again.`);
  }

  const calls: ChatToolCall[] = [];
  for (const { name, argsText } of accumulator.values()) {
    if (!KNOWN_TOOL_NAMES.has(name as ChatToolCall["name"])) continue;
    try {
      calls.push({ name: name as ChatToolCall["name"], args: JSON.parse(argsText) });
    } catch {
      // Malformed tool-call arguments (e.g. truncated JSON) — skip rather than crash.
    }
  }
  return calls;
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
): AsyncGenerator<string, ChatToolCall[], void> {
  const cleanedHistory = cleanChatHistory(history);
  const { recentHistory, olderSummary } = await condenseHistoryForModel(cleanedHistory);

  const systemPrompt = buildRichSystemPrompt(
    node, project, profile, mapCtx, recentConcerns, codeFiles, cleanedHistory, completedStepIndices, olderSummary
  );

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    ...recentHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: userMessage },
  ];

  const stream = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 16384,
    messages,
    tools: CHAT_TOOLS,
    stream: true,
  });

  const toolCalls = yield* consumeCompletionStreamWithTools(stream);
  return toolCalls;
}

export async function* streamOpeningMessage(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  mapCtx: MapContext,
  recentConcerns: string[],
  codeFiles: CodeFile[],
  regeneration?: { reason: string; facts: string[] }
): AsyncGenerator<string> {
  const systemPrompt = buildRichSystemPrompt(node, project, profile, mapCtx, recentConcerns, codeFiles);

  const isExplainerNode = node.isExtra
    ? /understand|concept|what is|how does|introduc|overview|fundament|theory|explain|learn about/i.test(`${node.title} ${node.brief}`)
    : false;

  const stepStyleNote = isExplainerNode
    ? `This is a concept-explainer node. Each step should explain a concept or idea progressively — break the concept into digestible understanding blocks. Steps are about building mental models, NOT about doing/building things.`
    : `Each step should be a concrete, actionable task the learner will DO. Steps are about building, writing, running, or verifying something tangible.`;

  const regenerationSection = regeneration
    ? `\n## You are REGENERATING an existing session from scratch
The learner already had a conversation on this node's previous plan. That plan is being thrown out and rebuilt because: ${regeneration.reason}
${regeneration.facts.length > 0
        ? `\nFacts and decisions already established in this session that the new plan MUST stay consistent with:\n${regeneration.facts.map((f) => `- ${f}`).join("\n")}\n`
        : ""}
`
    : "";

  const userPrompt = `[Opening message for node: "${node.title}"]
${regenerationSection}
Generate a structured session plan using EXACTLY this format with the slide markers. Do not add any text before [SLIDE:intro].

[SLIDE:intro]
In 1–3 sentences, state what this session covers end-to-end — what the learner will know or have built by the end. Then end with ONE specific checkpoint question that verifies the learner's current observable state before starting (based on what the completed nodes above say was accomplished). The question must be about what the learner can SEE or RUN right now. If this is the very first node OR a pure theory node with no runnable artifact, skip the checkpoint and instead write: "Let's get started — select the first step to begin."

[SLIDE:1]
**Step Title (short, action-oriented)**

${isExplainerNode ? "Explain this concept/idea clearly with concrete examples. Build understanding progressively. 3–6 sentences." : "Describe exactly what the learner will do, which command/file/tool is involved, and what outcome to expect. 3–6 sentences."}

[SLIDE:2]
**Step Title**

...

(Continue for all steps — aim for 3–6 steps total. Each step should represent ~5–10 minutes of focused work.)

Each step's title and description must be distinct and specific to what THAT step covers — never reuse or paraphrase another step's wording, and never let a later step just restate step 1.

${stepStyleNote}

Use the actual filenames, commands, component names, and domain terms from this project — never generic placeholders.
Use LaTeX math notation ($...$ for inline, $$...$$ for block) for any formulas or equations.
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

  yield* consumeCompletionStream(stream);
}

export async function* streamStepDetail(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  mapCtx: MapContext,
  codeFiles: CodeFile[],
  stepIndex: number,
  stepTitle: string,
  stepBrief: string
): AsyncGenerator<string> {
  const systemPrompt = buildRichSystemPrompt(node, project, profile, mapCtx, [], codeFiles);

  const isExplainer = /understand|concept|what is|how does|introduc|overview|fundament|theory|explain|learn about/i.test(
    `${node.title} ${node.brief} ${stepTitle}`
  );

  const langNote = profile?.preferredLanguage && profile.preferredLanguage !== "English"
    ? `\nIMPORTANT: Respond entirely in ${profile.preferredLanguage}. Code, commands, and technical terms may stay in English.`
    : "";

  // Deliberately scoped to ONLY this step's own title/brief (plus the standard rich
  // system prompt) — no sibling-step context. The title/brief is the single source of
  // truth for what this page teaches, so a correction made via update_step (which
  // rewrites title/brief) fully determines the regenerated content on its own, without
  // depending on a stale view of the rest of the plan.
  const prompt = `You are generating the detailed content page for step ${stepIndex} of the session on "${node.title}".

## This step
**${stepTitle}** — ${stepBrief}

## Your task
Write a detailed, self-contained content page for this step. Structure it as follows:

${isExplainer ? `
1. **What you'll understand** — One sentence stating the mental model you'll build.
2. **The core idea** — 2–4 sentences explaining the concept clearly, using a concrete analogy or small example from the project.
3. **Breaking it down** — Walk through each sub-concept or component with a short explanation. For every technical term, syntax, or idea appearing for the **first time**, add an inline callout:
   > 💡 **term**: One-sentence plain-English definition.
4. **Worked example** — Show the concept applied directly to "${project.title}" with code or diagrams if relevant.
5. **Common misconception** — One thing learners often get wrong here and why.
` : `
1. **What you'll build** — One sentence stating the concrete outcome of this step.
2. **Sub-steps** — Numbered list of exact actions. For each sub-step:
   - State the precise action (exact command, file to edit, UI element to click)
   - Show the code or command in a fenced block with the correct language tag
   - For any flag, option, method, or concept appearing for the **first time**, add an inline callout immediately after:
     > 💡 **term**: One-sentence plain-English definition.
3. **Expected result** — What the learner should see or be able to verify when this step is done.
4. **If something goes wrong** — The most likely failure mode and how to fix it.
`}

Rules:
- Use the real filenames, commands, variable names, and domain terms from "${project.title}".
- Keep every explanation short and concrete — no padding.
- Code blocks must have correct language tags (\`\`\`bash, \`\`\`ts, etc.).
- Never repeat content from other steps — stay focused on this step only.
- Use LaTeX math notation ($...$ for inline, $$...$$ for block) for any formulas or equations.${langNote ? `\n${langNote}\n- IMPORTANT: Translate ALL section headings (e.g. "What you'll build", "Sub-steps", "Expected result", "If something goes wrong", "What you'll understand", "The core idea", "Breaking it down", "Worked example", "Common misconception") into the target language. Only code, commands, and technical identifiers stay in English.` : ""}`;

  const stream = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    stream: true,
  });

  yield* consumeCompletionStream(stream);
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
  chatHistory: ChatMessage[],
  profile?: LearnerProfile | null
): Promise<string> {
  const conversationSample = chatHistory
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Learner" : "Tutor"}: ${m.content.slice(0, 300)}`)
    .join("\n");

  const langNote = getLanguageInstruction(profile ?? null);

  const prompt = `Based on this node's content and learning conversation, write a ONE-LINE summary (max 15 words) of what was learned.

Node: "${node.title}" — ${node.brief}
Project: "${project.title}"

Recent conversation:
${conversationSample}

Write a crisp one-liner summary of the key takeaway or skill gained. Start with a verb. No quotes.${langNote}`;

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

/**
 * Condenses a chat history into a short list of durable facts/corrections/decisions
 * (e.g. a renamed directory, a swapped tool version) for use when regenerating a
 * session plan. Feeding the model a distilled fact list instead of the raw transcript
 * keeps the regeneration prompt focused, rather than risking the transcript's bulk
 * crowding out per-step variety in the output.
 */
export async function extractSessionFacts(history: ChatMessage[]): Promise<string[]> {
  if (history.length === 0) return [];

  const transcript = history
    .slice(-30)
    .map((m) => `${m.role === "user" ? "Learner" : "Tutor"}: ${m.content.slice(0, 500)}`)
    .join("\n\n");

  const prompt = `Below is a tutoring conversation transcript for one learning session.

${transcript}

Task: Extract a short bullet list of concrete facts, corrections, or decisions established during this conversation that any future instructions for this session MUST stay consistent with — e.g. a renamed directory, a different tool/library version, a corrected command, a naming or architecture decision. Do NOT include vague summary sentences, teaching content, or anything that isn't a durable fact/decision. If nothing durable was established, return an empty list.

Respond ONLY with valid JSON, no markdown:
{"facts": ["fact 1", "fact 2"]}`;

  try {
    const response = await openrouter.chat.completions.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    const content = response.choices[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content) as { facts?: unknown };
    return Array.isArray(parsed.facts)
      ? parsed.facts.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

interface StepUpdateResult {
  title: string;
  brief: string;
}

// Phase 1 of the two-phase step-update flow: the chat model only flags WHICH step needs
// to change and WHY (via the update_step tool's stepNumber + reason) — it does not author
// the new title/brief itself. This dedicated, narrowly-scoped call writes the new
// title/brief, so its quality/consistency doesn't depend on whatever else was in the main
// chat turn's context. Phase 2 (streamStepDetail) then regenerates the step's detail page
// from ONLY this new title/brief — so the brief produced here must be concise but
// self-contained enough to drive that regeneration on its own.
export async function generateStepUpdate(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  reason: string,
  currentStep: { title: string; brief: string },
  siblingSteps: { title: string; brief: string }[]
): Promise<StepUpdateResult> {
  const siblingText = siblingSteps.length > 0
    ? siblingSteps.map((s) => `- **${s.title}** — ${s.brief}`).join("\n")
    : "(none — this is the only other step)";

  const prompt = `You are revising ONE step of an existing learning session plan for the project "${project.title}" (node: "${node.title}").

## Why this step needs to change
${reason}

## This step's current version (being replaced)
**${currentStep.title}** — ${currentStep.brief}

## Other steps in this session (context only — do not rewrite these, just stay consistent with their style, scope, and granularity)
${siblingText}

## Your task
Write the NEW title and brief for ONLY the step above, reflecting the reason for the change.
- Title: an ultra-short noun phrase (1–2 words, matching the style of the other steps' titles) — no filler like "Fundamentals of" or "Introduction to".
- Brief: 1–2 sentences describing a concrete OUTCOME (what the learner will build/implement/demonstrate), not just a topic.
- The brief is the ONLY context that will be used to generate this step's full detailed walkthrough later — nothing else from this conversation carries forward. It must be concise but complete: capture every fact/decision from the reason above that changes what the learner will actually do in this step (e.g. a specific tool, board, file path, or approach), not just a vague restatement of the old brief.

Respond ONLY with valid JSON, no markdown:
{"title": "...", "brief": "..."}`;

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Step update generation returned no content");

  const parsed = JSON.parse(content) as { title?: unknown; brief?: unknown };
  if (typeof parsed.title !== "string" || !parsed.title.trim() || typeof parsed.brief !== "string" || !parsed.brief.trim()) {
    throw new Error("Step update generation returned an invalid shape");
  }

  return { title: parsed.title.trim(), brief: parsed.brief.trim() };
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
