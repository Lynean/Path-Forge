import { openrouter } from "@workspace/integrations-openrouter-ai";
import type { LearnerProfile } from "@workspace/db";

const MODEL = "google/gemini-2.5-flash-lite";

interface AINode {
  id: string;
  title: string;
  brief: string;
  status: "locked" | "available" | "completed";
  is_extra: boolean;
  prerequisite_ids: string[];
}

interface AINodeMapResponse {
  nodes: AINode[];
}

export async function generateNodeMap(
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null
): Promise<AINodeMapResponse> {
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
    : "No profile available — generate a general learning path.";

  const systemPrompt = `You are an expert curriculum designer for self-directed learners. Your job is to generate a structured, personalized learning node map (a directed acyclic graph of learning steps) for a given project idea.

The learner profile is:
${profileContext}

Rules for the node map:
- Generate 8–16 nodes that form a coherent learning path to complete the described project.
- Nodes with no prerequisites are "starter" nodes — set status to "available". All others start "locked".
- Each node must have: a short title (max 8 words), a brief 1–2 sentence description of what will be learned, and an array of prerequisite node IDs (can be empty).
- The graph must be a DAG — no cycles.
- Tailor depth and vocabulary to the learner's profile. A PhD student gets more advanced topics; a high school student gets foundational concepts.
- Cover the relevant technology stack and concepts needed to build the project (e.g., Python, data structures, networking, robotics frameworks, web APIs, etc.).
- Think carefully about ordering: fundamentals before advanced topics, theory before implementation.

Respond ONLY with valid JSON matching this exact schema, no markdown:
{
  "nodes": [
    {
      "id": "n1",
      "title": "Short Node Title",
      "brief": "1-2 sentence description of what the learner will learn in this step.",
      "status": "available",
      "is_extra": false,
      "prerequisite_ids": []
    }
  ]
}`;

  const userPrompt = `Project: "${project.title}"
Description: ${project.ideaPrompt}

Generate the learning node map for this project.`;

  let attempts = 0;
  const maxAttempts = 3;
  let lastError: unknown;

  while (attempts < maxAttempts) {
    try {
      const response = await openrouter.chat.completions.create({
        model: MODEL,
        max_tokens: 8192,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from AI");

      const parsed = JSON.parse(content) as AINodeMapResponse;

      if (!parsed.nodes || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
        throw new Error("AI returned invalid node map structure");
      }

      for (const node of parsed.nodes) {
        if (!node.id || !node.title || !node.brief) {
          throw new Error(`Node missing required fields: ${JSON.stringify(node)}`);
        }
        if (!["locked", "available", "completed"].includes(node.status)) {
          node.status = "locked";
        }
        if (!Array.isArray(node.prerequisite_ids)) {
          node.prerequisite_ids = [];
        }
      }

      return parsed;
    } catch (err) {
      lastError = err;
      attempts++;
      if (attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempts));
      }
    }
  }

  throw lastError;
}
