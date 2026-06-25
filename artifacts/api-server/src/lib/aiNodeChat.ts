import { openrouter } from "@workspace/integrations-openrouter-ai";
import type { LearnerProfile, Node as DbNode } from "@workspace/db";

const MODEL = "google/gemini-2.5-flash-lite";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

function buildSystemPrompt(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null
): string {
  const profileContext = profile
    ? [
        profile.age ? `Age: ${profile.age}` : null,
        profile.educationLevel ? `Education: ${profile.educationLevel}` : null,
        profile.major ? `Field/Major: ${profile.major}` : null,
        profile.interests ? `Interests: ${profile.interests}` : null,
        profile.experience ? `Experience: ${profile.experience}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "No profile — assume intermediate level.";

  return `You are a personalized AI tutor for the learning topic: "${node.title}".

The learner is building: "${project.title}" — ${project.ideaPrompt}

Learner Profile:
${profileContext}

Your role:
- Teach the topic of this node: "${node.title}"
- Topic overview: ${node.brief}
- Tailor your explanations to this learner's background and level.
- Use concrete examples and analogies relevant to their project.
- Ask clarifying questions if needed.
- Be concise but thorough. Use markdown for code blocks and lists.
- When the learner seems to have grasped the topic, suggest they mark the node complete.
- If they ask about a related topic NOT in this node, mention it briefly and suggest they explore it as a separate topic (hinting they can spawn a new node).

Stay focused on this specific learning topic. Do not go off on tangents.`;
}

export async function* streamNodeChatMessage(
  node: DbNode,
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null,
  history: ChatMessage[],
  userMessage: string
): AsyncGenerator<string> {
  const systemPrompt = buildSystemPrompt(node, project, profile);

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: userMessage },
  ];

  const stream = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
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
  const profileContext = profile
    ? `Age: ${profile.age ?? "unknown"}, Education: ${profile.educationLevel ?? "unknown"}, Field: ${profile.major ?? "unknown"}, Experience: ${profile.experience}`
    : "No profile — intermediate level.";

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
