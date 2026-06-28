import { openrouter } from "@workspace/integrations-openrouter-ai";
import type { LearnerProfile } from "@workspace/db";

const MODEL = "google/gemini-3.1-flash-lite";

const SYSTEM = `You generate self-contained HTML concept visualizations.
Rules:
- Single HTML file. Embedded CSS and JS only. Zero external libraries or CDN links.
- Palette: black (#111111), white (#f5f5f5), red (#e74c3c), blue (#3b82f6). No other colors.
- Animate or make interactive where it helps understanding. Canvas, CSS animations, and vanilla JS are all fine.
- Keep it minimal and clear — no decorative chrome, no legends unless needed.
- Calibrate complexity to the learner's level: beginner = step-by-step with labels; advanced = denser, more abstract.
- CRITICAL: Your entire response must be raw HTML starting with <!DOCTYPE html> or <html>. Do NOT wrap in markdown code fences. Do NOT write any explanation before or after. First character of your response must be '<'.`;

export async function* streamVisualization(
  topic: string,
  nodeTitle: string,
  profile: LearnerProfile | null
): AsyncIterable<string> {
  const learnerCtx = profile
    ? [
        profile.experience ? `Experience: ${profile.experience}` : null,
        profile.educationLevel ? `Education: ${profile.educationLevel}` : null,
        profile.major ? `Major: ${profile.major}` : null,
      ]
        .filter(Boolean)
        .join(" | ")
    : null;

  const userMsg = [
    `Node: "${nodeTitle}"`,
    learnerCtx ? `Learner: ${learnerCtx}` : null,
    `Visualize: ${topic}`,
  ]
    .filter(Boolean)
    .join("\n");

  const stream = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 4096,
    stream: true,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userMsg },
    ],
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}
