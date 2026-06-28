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
  completedStepIndices?: number[]
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

10. Suggest a new node only when the learner raises a clearly distinct topic not covered anywhere in the existing map.

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

  const userPrompt = `[Opening message for node: "${node.title}"]
Generate a tutor opening message that:
1. In 1–2 sentences, states what this session covers end-to-end.
2. Lists ALL the mini-steps for this session as a numbered list. For each step, write the step title followed by a dash and 1–3 sentences explaining exactly what the learner will do and why — be concrete (mention specific commands, filenames, or functions). Example format:
   1. Step title — What you'll do, why it matters, and any key detail or command.
   2. Step title — Specific action with the exact tool/command/file involved.
3. End with ONE specific checkpoint question that verifies the learner's current observable state before starting — based on what the completed nodes above say was accomplished. The question must be about what the learner can SEE or RUN right now, not about their code:
   - Code projects: "Can you run [actual filename] and see [specific expected output/behaviour]?" e.g. "Can you run main.py and see a black Tkinter window appear?"
   - Hardware: "Is [component] connected to [pin] and showing [expected behaviour]?" e.g. "Is the LED on pin 13 lighting up when you power the board?"
   - Data/analytics: "Can you open [file] and confirm it has [expected columns/shape]?"
   - Workflow tools: "Can you open [tool] and see [specific workflow/sheet] in [expected state]?"
   - If this is the very first node with no completed prerequisites: skip the checkpoint and end with "Let's start with step 1." then give the first concrete action immediately.
   - If this is a theory/math/concept node with no runnable artifact: skip the checkpoint and end with "Let's start with step 1." then begin the first explanation directly.
   Keep the checkpoint to one sentence. Use the actual filename, tool, component, or command from this project — never a generic placeholder.
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
