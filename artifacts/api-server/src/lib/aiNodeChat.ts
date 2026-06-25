import { openrouter } from "@workspace/integrations-openrouter-ai";
import type { LearnerProfile, Node as DbNode } from "@workspace/db";

const MODEL = "google/gemini-2.5-flash-lite";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface MapContext {
  allNodes: { id: number; title: string; brief: string; status: string; summary?: string | null }[];
  allEdges: { fromNodeId: number; toNodeId: number }[];
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

function buildRichSystemPrompt(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  mapCtx: MapContext,
  recentConcerns: string[]
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

  return `You are a personalized AI tutor for the learning topic: "${node.title}".

## Project Context
The learner is building: "${project.title}"
Description: ${project.ideaPrompt}

## Learner Profile
${profileContext}

## Current Node
Title: ${node.title}
Overview: ${node.brief}

## Learning Progress
### Completed nodes (with summaries):
${completedSummaries}

### Full map overview (✓=completed, →=available, ○=locked):
${mapOverview}

### Recent learner concerns (from latest conversations):
${recentConcernsText}

## Your Role
1. Teach the content of "${node.title}" clearly and deeply, tailored to this learner's background.
2. Use concrete code examples relevant to the project "${project.title}".
3. Share practical tips, tricks, and performance improvements applicable right now.
4. Identify important field knowledge NOT yet in the map and recommend adding it as a new node when relevant.
5. Acknowledge any recent concerns from the learner's prior sessions naturally.
6. When the learner demonstrates understanding, suggest they mark this node as complete.
7. Use markdown for code (use proper language tags for syntax highlighting), bullet lists, and bold key terms.
8. Be concise but thorough — no fluff.`;
}

export async function* streamNodeChatMessage(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  history: ChatMessage[],
  userMessage: string,
  mapCtx: MapContext,
  recentConcerns: string[]
): AsyncGenerator<string> {
  const systemPrompt = buildRichSystemPrompt(node, project, profile, mapCtx, recentConcerns);

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
  recentConcerns: string[]
): AsyncGenerator<string> {
  const systemPrompt = buildRichSystemPrompt(node, project, profile, mapCtx, recentConcerns);

  const userPrompt = `I'm ready to start learning "${node.title}". Give me a rich, engaging introduction that:
1. Explains why this topic is important for my project
2. Outlines what I'll learn in this session
3. Provides key context or prerequisites I should know
4. Gives me a concrete first example or concept to get started
Keep it focused and actionable.`;

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
3. Is specific enough to be a standalone 20-30 minute learning topic

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
1. Keep completed nodes exactly as-is (don't include them in your output)
2. You may update, remove, or add future nodes to match the new direction
3. Keep the same node IDs where possible (reuse them if the node concept is retained)
4. Add new nodes with new IDs like "new1", "new2", etc.
5. Maintain a coherent prerequisite graph (DAG, no cycles)
6. 8-16 total nodes (completed + future combined)
7. Nodes should still lead toward the same final project goal

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
