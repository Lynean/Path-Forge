import { openrouter } from "@workspace/integrations-openrouter-ai";
import type { LearnerProfile } from "@workspace/db";

const MODEL = "google/gemini-3.1-flash-lite";

function getLangInstruction(profile: LearnerProfile | null): string {
  const lang = profile?.preferredLanguage;
  if (!lang || lang === "English") return "";
  return `\nIMPORTANT: All human-readable text (questions, descriptions, node briefs, option text) must be written in ${lang}. Node titles and code/technical identifiers must stay in English.`;
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

function buildMapProjectTypeRules(types: ProjectType[]): string {
  if (types.length === 0) return "";
  const has = (...t: ProjectType[]) => t.some((x) => types.includes(x));
  const blocks: string[] = ["\nProject-type node requirements — apply the relevant rules:"];

  if (types.includes("algorithm")) blocks.push(`ALGORITHM / COMPETITIVE PROGRAMMING (LeetCode, Codeforces, HackerRank, olympiad):
- Include nodes for: problem decomposition, identifying the algorithm pattern, brute-force implementation, optimisation to target complexity, edge case analysis, and final submission-ready solution.
- Complexity analysis (time + space) must be its own node or explicitly part of the optimisation node — not optional.`);

  if (types.includes("math-impl")) blocks.push(`MATH + IMPLEMENTATION (deep learning, ML, numerical methods, signal processing):
- Pair every math concept node with a corresponding implementation node — intuition before code, not instead of it.
- Include nodes for the mathematical foundations (e.g. gradient descent derivation, matrix operations, probability basics) even if the learner is an experienced coder. The math IS the learning.
- Include a node for running and interpreting the first training/evaluation result (loss curve, accuracy, confusion matrix).`);

  if (types.includes("hardware")) blocks.push(`HARDWARE / EMBEDDED (Arduino, Raspberry Pi, IoT, embedded C/C++):
- Include a dedicated node for reading the relevant datasheet sections (pin assignment, voltage/current limits, timing diagram, communication protocol registers) — this is a skill node, not background reading.
- Pair every hardware component with a wiring/circuit node before any code node that drives it.
- Include a serial-monitor / debug-output node to verify hardware behavior before building higher-level logic.
- Final node must verify observed physical behavior, not just compile success.`);

  if (types.includes("robotics")) blocks.push(`ROBOTICS / SIMULATION (ROS2, Webots, Gazebo, MATLAB/Simulink):
- Include nodes for: ROS2 workspace and package setup, the computation graph design (which nodes publish/subscribe to which topics), individual node implementation, launch file, and simulation verification.
- Include a node explicitly for understanding the gap between simulation results and real-hardware behavior if the project targets a physical robot.
- TF transforms, URDF, or sensor integration each deserve their own node if the project uses them.`);

  if (types.includes("workflow-tools")) blocks.push(`VISUAL / WORKFLOW TOOLS (n8n, Excel, SAS, Power BI, Zapier, IBM multi-agent):
- Include nodes for: tool setup and first workflow/workbook, core logic implementation, error handling and failure paths, testing with realistic data, and exporting/versioning the config.
- Do NOT skip the error-handling node — workflows that silently fail are a known real-world problem.
- For multi-agent systems: include nodes for agent role definition, inter-agent communication design, and end-to-end orchestration test.`);

  if (types.includes("cybersecurity")) blocks.push(`CYBERSECURITY (penetration testing, security analysis, hardening, CTF):
- Structure nodes to follow methodology: reconnaissance → enumeration → vulnerability identification → (if authorized) exploitation → evidence documentation → remediation recommendation. Do not skip the documentation and remediation nodes.
- Include a node for setting up the authorized test environment or lab — never assume the learner works on a live production system.
- Include a node for interpreting tool output (nmap, Burp Suite, Metasploit, etc.) separately from learning the tool syntax.
- Final node must produce a written finding with impact and remediation — not just a successful exploit.`);

  if (types.includes("data-analytics")) blocks.push(`DATA ANALYTICS (Python/R/SQL analysis, Excel analytics, BI dashboards, statistical modeling):
- First nodes must address data loading and quality assessment (missing values, types, outliers, data source understanding) before any analysis.
- Include a node connecting each analysis step to the business question it answers.
- Include a reproducibility node: script-based pipeline, documented assumptions, version-controlled notebook or parameterized query.
- Final node must produce an interpretable result for a non-technical reader (chart, table, written summary).`);

  if (types.includes("enterprise-integration")) blocks.push(`NO-CODE / ENTERPRISE INTEGRATION (n8n, Zapier, Make, corporate AI integration, low-code platforms):
- Include nodes for: integration architecture design, individual connector/API setup, data mapping and transformation, error and retry handling, and end-to-end integration test.
- Include a node for cost/rate-limit awareness if the integration involves paid APIs or AI model calls.
- Final node must demonstrate the integration handling both a success case and a failure case.`);

  if (has("document-heavy", "hardware")) blocks.push(`DOCUMENT-HEAVY WORK (datasheets, RFCs, whitepapers, manuals, academic papers):
- Include dedicated nodes for document navigation skills (finding the right section, reading tables and diagrams) — not just "read the datasheet."
- Pair each document-reading node with an application node where the learner uses what they extracted (e.g., wire a component using the pin table they just read).`);

  if (types.includes("theory")) blocks.push(`PURE THEORY / MATH (foundational math, algorithms theory, system design):
- Include nodes that build intuition before formalism — concrete examples before general proofs.
- Pair every abstract concept node with an application node where the learner uses or re-derives it.`);

  // Version control — always append for multi-file intermediate+ projects
  const needsGit = !types.includes("algorithm") && !types.includes("theory") && !types.includes("workflow-tools");
  if (needsGit) blocks.push(`VERSION CONTROL:
- If the project has more than one file, spans multiple sessions, or involves iterative development, include a Git setup node early (after environment setup, before first implementation).
- For collaborative or deployment-bound projects, include a branching strategy or CI/CD node later in the map.`);

  return blocks.join("\n\n");
}

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
        profile.profileSummary ? profile.profileSummary : null,
        profile.preferredLanguage ? `Preferred language: ${profile.preferredLanguage}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "No profile available.";

  const langInstruction = getLangInstruction(profile);

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
{"questions": [{"id": "q1", "question": "...", "options": ["...", "...", "..."]}, ...]}${langInstruction}`;

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
        profile.profileSummary ? profile.profileSummary : null,
        profile.preferredLanguage ? `Preferred language: ${profile.preferredLanguage}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "No profile available.";

  const qaText = qa.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join("\n\n");
  const langInstruction = getLangInstruction(profile);

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

Return ONLY the rewritten description, no quotes, no preamble.${langInstruction}`;

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty AI response for description refinement");
  return content;
}

const RECOMMENDATION_CATEGORIES: ProjectType[] = [
  "algorithm", "math-impl", "hardware", "robotics", "workflow-tools",
  "cybersecurity", "data-analytics", "enterprise-integration", "document-heavy", "theory",
];

export interface ProjectRecommendation {
  title: string;
  description: string;
  category: ProjectType;
}

export interface ProjectRecommendationsResponse {
  recommendations: ProjectRecommendation[];
}

export async function generateProjectRecommendations(
  profile: LearnerProfile | null,
  existingProjectTitles: string[]
): Promise<ProjectRecommendationsResponse> {
  const profileContext = profile
    ? [
        profile.age ? `Age: ${profile.age}` : null,
        profile.educationLevel ? `Education: ${profile.educationLevel}` : null,
        profile.major ? `Field/Major: ${profile.major}` : null,
        profile.profileSummary ? profile.profileSummary : null,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  const existingText = existingProjectTitles.length > 0
    ? `\nThe learner already has these projects — do not suggest duplicates or near-duplicates of them:\n${existingProjectTitles.map((t) => `- ${t}`).join("\n")}`
    : "";

  const langInstruction = getLangInstruction(profile);

  const prompt = `You are suggesting project ideas to a self-directed learner on a project-based learning platform. Each idea becomes a full personalized learning path if they choose it, so ideas must be genuinely buildable as a self-directed learning project — not a vague concept and not a full commercial product.

Learner profile:
${profileContext ?? "No profile available — suggest a broadly appealing, popular mix spanning different skill levels and domains."}
${existingText}

Generate exactly 10 diverse, exciting project ideas tailored to this learner. Requirements:
- Calibrate difficulty to their stated experience in each area — not trivial if they're experienced, not overwhelming if they're a beginner.
- Cover a MIX of their stated interests when they have a profile, plus 1–2 stretch/adjacent ideas that broaden their horizons into something adjacent but new.
- If there's no profile, spread the 10 across different domains and difficulty levels so there's something for everyone.
- title: punchy and concrete, max 6 words, no generic buzzwords ("Awesome", "Ultimate").
- description: exactly 1–2 sentences, concrete about what they'll actually build, written in a motivating/exciting tone that sells why it's worth building.
- category: pick the single best-fit tag from this exact list (lowercase, exact spelling): ${RECOMMENDATION_CATEGORIES.join(", ")}.

Respond ONLY with valid JSON, no markdown:
{"recommendations": [{"title": "...", "description": "...", "category": "..."}, ...]} — exactly 10 items.${langInstruction}`;

  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty AI response");

  const parsed = JSON.parse(content) as ProjectRecommendationsResponse;
  if (!parsed.recommendations || !Array.isArray(parsed.recommendations)) {
    throw new Error("Invalid recommendations response");
  }

  const categorySet = new Set<string>(RECOMMENDATION_CATEGORIES);
  const recommendations = parsed.recommendations
    .filter((r) => r && typeof r.title === "string" && typeof r.description === "string" && r.title.trim() && r.description.trim())
    .map((r) => ({
      title: r.title.trim(),
      description: r.description.trim(),
      category: categorySet.has(r.category) ? r.category : ("theory" as ProjectType),
    }))
    .slice(0, 10);

  if (recommendations.length === 0) throw new Error("AI returned no usable recommendations");
  return { recommendations };
}

export async function generateNodeMap(
  project: { title: string; ideaPrompt: string },
  profile: LearnerProfile | null
): Promise<AINodeMapResponse> {
  const projectTypes = detectProjectTypes(`${project.title} ${project.ideaPrompt}`);
  const projectTypeRules = buildMapProjectTypeRules(projectTypes);

  const profileContext = profile
    ? [
        profile.age ? `Age: ${profile.age}` : null,
        profile.educationLevel ? `Education: ${profile.educationLevel}` : null,
        profile.major ? `Field/Major: ${profile.major}` : null,
        profile.profileSummary ? profile.profileSummary : null,
        profile.preferredLanguage ? `Preferred language: ${profile.preferredLanguage}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "No profile available — generate a general learning path.";

  const langInstruction = getLangInstruction(profile);

  const systemPrompt = `You are an expert curriculum designer for self-directed learners. Your job is to generate a structured, personalized learning node map (a directed acyclic graph of learning steps) for a given project idea.

The learner profile is:
${profileContext}

Rules for the node map:
- Generate as many nodes as the project genuinely requires — typically 6–10 for small/focused projects, 12–20 for medium projects, and 20–35 for large multi-component projects. Do NOT pad with trivial nodes to hit a number, and do NOT compress distinct topics into one node to stay under a limit.
- Each node represents a focused ~15-minute chunk. The brief must describe a concrete OUTCOME — what the learner will build, implement, or demonstrate — not just what they will "understand" or "learn about".
- Starter nodes (no prerequisites): set status to "available". All others start "locked".
  - Prefer 1–3 parallel starter nodes when distinct skills can be acquired independently at the outset (e.g., setting up the environment AND learning a core data structure at the same time).
- The final node(s) should integrate prior learning into a working, testable piece of the project.
- Each node must have: a 1–2 word title, a 1–2 sentence brief with a concrete outcome, and an array of prerequisite node IDs (can be empty). Titles must be ultra-short noun phrases — drop filler words like "Fundamentals of", "Introduction to", "Working with". If multiple nodes share the same concept, append a roman numeral to distinguish them (e.g. "Snake Movement I", "Snake Movement II"). Never exceed 3 words even with a roman numeral.
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
- If the project depends on a foundational choice that shapes every later step — a language/framework, an environment (local vs cloud, OS, cross-platform toolchain), a specific tool/platform version, a dataset — and the description doesn't already pin it down, resolve that choice as its own early node before any node that assumes a particular answer. Never let the learner discover a tooling/environment mismatch mid-implementation of a later node.
- Before any node whose instructions assume a specific capability is available (compute/memory/storage capacity, account tier, API scope, hardware resource, dataset size), include a node that confirms the learner's actual setup meets that requirement. A capability mismatch should surface as an early checkpoint, never for the first time as a failure during implementation.
- When a project involves non-trivial environment or tooling setup (cross-compilation, cloud accounts, lab environments, cross-platform builds, connector/API onboarding, GPU/cloud provisioning), give environment setup and verification its own dedicated node(s), separate from nodes that write or configure actual project logic — don't let environment debugging consume a code/logic node's scope.

${projectTypeRules}
${langInstruction}
Respond ONLY with valid JSON matching this exact schema, no markdown:
{
  "nodes": [
    {
      "id": "n1",
      "title": "Node Title",
      "brief": "1-2 sentence description of what the learner will learn in this step.",
      "is_extra": false,
      "prerequisite_ids": []
    },
    {
      "id": "n2",
      "title": "Next Topic",
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
