import { openrouter } from "@workspace/integrations-openrouter-ai";
import type { LearnerProfile } from "@workspace/db";

const MODEL = "google/gemini-3.1-flash-lite";

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

interface FramingQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface FramingQuestionsResponse {
  questions: FramingQuestion[];
}

export async function generateFramingQuestions(
  title: string,
  ideaPrompt: string,
  profile: LearnerProfile | null
): Promise<FramingQuestionsResponse> {
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
    : "No profile available.";

  const prompt = `You are helping a learner clarify their project before generating a personalized learning path.

Project title: "${title}"
Project idea: "${ideaPrompt}"

Learner profile:
${profileContext}

Generate 5–8 multiple-choice questions that will sharpen the project scope so the learning path is maximally relevant. Focus on:
- The specific outcome they want (learn how it works? ship something? compete? demo?)
- Technical constraints or preferences (language, framework, platform, hardware)
- Scope and complexity expectations
- Key features or sub-goals they care most about

Rules:
- Each question must be specific to THIS project — no generic questions that could apply to any project
- 3–4 options per question, each concrete and meaningfully distinct
- Avoid yes/no questions; every option should be an actionable choice
- Keep questions short (under 15 words)
- Skip questions whose answers are already clear from the idea description or profile

Respond ONLY with valid JSON, no markdown:
{"questions": [{"id": "q1", "question": "...", "options": ["...", "...", "..."]}, ...]}`;

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty AI response");

  const parsed = JSON.parse(content) as FramingQuestionsResponse;
  if (!parsed.questions || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error("Invalid framing questions response");
  }
  return parsed;
}

export async function generateRefinedDescription(
  title: string,
  originalDescription: string,
  qa: { question: string; answer: string }[],
  profile: LearnerProfile | null
): Promise<string> {
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
    : "No profile available.";

  const qaText = qa.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join("\n\n");

  const prompt = `You are rewriting a project description to incorporate the learner's specific goals and context.

Project title: "${title}"
Original description: "${originalDescription}"

Learner answered these clarifying questions:
${qaText}

Learner profile:
${profileContext}

Rewrite the project description as a single cohesive paragraph (4–7 sentences) that naturally weaves in everything revealed by the answers. Requirements:
- Keep the core project idea intact
- Be specific and concrete — reference the exact goals, stack, constraints, and scope the learner chose
- Written in first person ("I want to build...")
- Sound like the learner wrote it themselves — not like a Q&A summary
- No bullet points, no section headers — a single flowing paragraph

Return ONLY the rewritten description, no quotes, no preamble.`;

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty AI response for description refinement");
  return content;
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
- Generate as many nodes as the project genuinely requires — typically 6–10 for small/focused projects, 12–20 for medium projects, and 20–35 for large multi-component projects. Do NOT pad with trivial nodes to hit a number, and do NOT compress distinct topics into one node to stay under a limit.
- Each node represents a focused ~15-minute chunk. The brief must describe a concrete OUTCOME — what the learner will build, implement, or demonstrate — not just what they will "understand" or "learn about".
- Starter nodes (no prerequisites): set status to "available". All others start "locked".
  - Prefer 1–3 parallel starter nodes when distinct skills can be acquired independently at the outset (e.g., setting up the environment AND learning a core data structure at the same time).
- The final node(s) should integrate prior learning into a working, testable piece of the project.
- Each node must have: a short title (max 8 words), a 1–2 sentence brief with a concrete outcome, and an array of prerequisite node IDs (can be empty).
- The graph must be a DAG — no cycles.
- CRITICAL — tailor to the learner's existing knowledge: read the profile carefully and SKIP topics they already know.
  - If they have years of Python/C experience: do NOT include nodes on basic syntax, variables, loops, functions, or I/O. Start from where their knowledge ends.
  - If they mention experience with a framework or tool (e.g. ROS2): treat it as prior knowledge and only include nodes that go beyond what they stated.
  - Focus the map on the GAPS between their current knowledge and what the project requires.
- Cover the relevant technology stack and concepts needed to build the project (e.g., data structures, networking, robotics frameworks, web APIs, etc.).
- Order thoughtfully: fundamentals before advanced topics, independent skills in parallel branches, theory paired with hands-on implementation.
- Avoid duplicate or near-duplicate nodes. If two candidate nodes produce the same artifact or verify the same outcome, consolidate them into one focused node.
- Treat explicit sequencing in the project description as authoritative. If the learner says one activity must come first, that activity must be a root or upstream prerequisite.
- Do not confuse validation/checkpoint tasks with starting tasks. Environment, Docker, deployment, benchmark, or acceptance-test validation should appear only after the artifacts being validated have been designed or built, unless the learner explicitly asks to validate an existing system first.
- For rebuild, migration, audit, or "recreate from existing project" requests, the first nodes should inspect source documentation/code and extract architecture/contracts before implementation or infrastructure validation.
- If a description corrects a prior map ordering (for example "Docker validation is not the first step"), honor that correction in node prerequisites and node ordering.

Respond ONLY with valid JSON matching this exact schema, no markdown:
{
  "nodes": [
    {
      "id": "n1",
      "title": "Short Node Title",
      "brief": "1-2 sentence description of what the learner will learn in this step.",
      "is_extra": false,
      "prerequisite_ids": []
    },
    {
      "id": "n2",
      "title": "Next Topic Title",
      "brief": "Description of what is learned here.",
      "is_extra": false,
      "prerequisite_ids": ["n1"]
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
