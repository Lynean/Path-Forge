export interface Slide {
  type: "intro" | "step";
  stepNumber?: number;
  title?: string;
  content: string;
  agentNote?: string;
  detailedContent?: string;
}

export function parseSlides(content: string): Slide[] {
  if (content.includes("[SLIDE:")) {
    const slides: Slide[] = [];
    const parts = content.split(/\[SLIDE:(\w+)\]/);
    for (let index = 1; index < parts.length - 1; index += 2) {
      const key = parts[index]?.trim() ?? "";
      const body = parts[index + 1]?.trim() ?? "";
      if (!body) continue;
      if (key === "intro") {
        slides.push({ type: "intro", content: body });
        continue;
      }

      const stepNumber = Number.parseInt(key, 10);
      if (!Number.isFinite(stepNumber)) continue;
      const titleMatch = body.match(/^\*\*([^*]+)\*\*/);
      const noteMatch = body.match(/\[NOTE:\s*([\s\S]*?)\]\s*$/i);
      slides.push({
        type: "step",
        stepNumber,
        title: titleMatch?.[1]?.trim() || `Step ${stepNumber}`,
        content: body
          .replace(/\[NOTE:\s*[\s\S]*?\]\s*$/i, "")
          .replace(/^\*\*[^*]+\*\*\s*\n?/, "")
          .trim(),
        ...(noteMatch?.[1]?.trim() ? { agentNote: noteMatch[1].trim() } : {}),
      });
    }
    if (slides.length > 0) return slides;
  }

  return content.trim() ? [{ type: "intro", content: content.trim() }] : [];
}

export function hydrateStepDetails(
  slides: Slide[],
  messages: Array<{ role: string; content: string }>,
): Slide[] {
  const details = new Map<number, string>();
  const pattern = /^\[STEP_DETAIL:(\d+)\]\n([\s\S]*)\n\[\/STEP_DETAIL:\d+\]$/;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const match = pattern.exec(message.content);
    if (match?.[1] && match[2] !== undefined) {
      details.set(Number.parseInt(match[1], 10), match[2]);
    }
  }
  return slides.map((slide) => {
    const detail = slide.stepNumber === undefined ? undefined : details.get(slide.stepNumber);
    return detail === undefined ? slide : { ...slide, detailedContent: detail };
  });
}

export function findOpeningMessage(
  messages: Array<{ role: string; content: string }>,
): string | null {
  return (
    messages.find(
      (message) =>
        message.role === "assistant" &&
        !message.content.startsWith("[STEP_DETAIL:"),
    )?.content ?? null
  );
}
