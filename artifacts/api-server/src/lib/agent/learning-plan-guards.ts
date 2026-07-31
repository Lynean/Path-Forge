export interface OpeningSlide {
  key: string;
  body: string;
}

export interface StepBoundary {
  title: string;
  brief?: string;
}

export function parseOpeningSlides(content: string): OpeningSlide[] {
  const slides: OpeningSlide[] = [];
  const parts = content.split(/\[SLIDE:(\w+)\]/);
  for (let index = 1; index < parts.length - 1; index += 2) {
    const key = parts[index]?.trim();
    const body = parts[index + 1]?.trim();
    if (key && body) slides.push({ key, body });
  }
  return slides;
}

export function serializeOpeningSlides(slides: OpeningSlide[]): string {
  return slides.map(({ key, body }) => `[SLIDE:${key}]\n${body}`).join("\n\n");
}

export function parseStepSlideBody(
  body: string,
): { title: string; brief: string; note?: string } {
  const match = /^\*\*(.+?)\*\*\s*\n+([\s\S]*)$/.exec(body.trim());
  if (!match) return { title: "", brief: body.trim() };
  const remainder = match[2]?.trim() ?? "";
  const noteMatch = remainder.match(/\[NOTE:\s*([\s\S]*?)\]\s*$/i);
  return {
    title: match[1]?.trim() ?? "",
    brief: remainder.replace(/\[NOTE:\s*[\s\S]*?\]\s*$/i, "").trim(),
    ...(noteMatch?.[1]?.trim() ? { note: noteMatch[1].trim() } : {}),
  };
}

export function formatStepSlideBody(step: {
  title: string;
  brief: string;
  note?: string;
}): string {
  return `**${step.title}**\n${step.brief}${step.note?.trim() ? `\n[NOTE: ${step.note.trim()}]` : ""}`;
}

export function noteWithCorrection(
  existingNote: string | undefined,
  issueNote: string,
): string {
  const base = existingNote
    ?.replace(/\n*CORRECTION ISSUE:[\s\S]*$/i, "")
    .trim();
  return [base, `CORRECTION ISSUE: ${issueNote.trim()}`]
    .filter(Boolean)
    .join("\n");
}

/** Embeds a broad correction into every lazy step-detail handoff. */
export function applySessionWideCorrectionInvariant(
  openingContent: string,
  reason: string,
): string {
  const slides = parseOpeningSlides(openingContent).map((slide) => {
    if (slide.key === "intro") return slide;
    const step = parseStepSlideBody(slide.body);
    return {
      ...slide,
      body: formatStepSlideBody({
        title: step.title,
        brief: step.brief,
        note: noteWithCorrection(
          step.note,
          `SESSION-WIDE INVARIANT: ${reason}`,
        ),
      }),
    };
  });
  return serializeOpeningSlides(slides);
}

export function buildEffectiveStepNote(params: {
  stepNote?: string;
  laterSteps: Array<{ stepNumber: number; title: string; brief: string }>;
  futureNodes: StepBoundary[];
}): string {
  const laterSteps = params.laterSteps.map(
    (step) => `Step ${step.stepNumber}: ${step.title} — ${step.brief}`,
  );
  const futureNodes = params.futureNodes.map(
    (node) => `${node.title}${node.brief ? ` — ${node.brief}` : ""}`,
  );
  return [
    params.stepNote?.trim(),
    laterSteps.length
      ? `AUTHORITATIVE LATER-STEP BOUNDARIES (out of scope now):\n${laterSteps.map((step) => `- ${step}`).join("\n")}`
      : "",
    futureNodes.length
      ? `AUTHORITATIVE FUTURE-NODE BOUNDARIES (out of scope for this entire node):\n${futureNodes.map((node) => `- ${node}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildCompletionProjectDocument(params: {
  nodeTitle: string;
  inspectionReport: string;
  completionSummary?: string | null;
  workspaceSnapshot: string | null;
}): string {
  const currentState =
    params.inspectionReport ||
    [
      `The learner completed "${params.nodeTitle}".`,
      params.completionSummary
        ? `Completion summary: ${params.completionSummary}`
        : null,
      params.workspaceSnapshot
        ? `Current bounded workspace snapshot:\n${params.workspaceSnapshot}`
        : "The workspace could not be inspected during this refresh.",
    ]
      .filter(Boolean)
      .join("\n\n");

  return (
    `# Project State\n\n` +
    `_Maintained by PathForge — refreshed after completing "${params.nodeTitle}"._\n\n` +
    `${currentState}\n` +
    (params.inspectionReport && params.workspaceSnapshot
      ? `\n## Bounded workspace snapshot\n\n${params.workspaceSnapshot}\n`
      : "")
  );
}

export function applyPlanEdits(
  openingContent: string,
  stepUpdates: Map<number, string>,
  newSteps: Array<{ title: string; brief: string }>,
  introUpdate?: string | null,
): { content: string; invalidatedStepNumbers: number[] } {
  const slides = parseOpeningSlides(openingContent);
  const invalidatedStepNumbers: number[] = [];
  for (const slide of slides) {
    if (slide.key === "intro") {
      if (introUpdate) slide.body = introUpdate;
      continue;
    }
    const stepNumber = Number.parseInt(slide.key, 10);
    if (!Number.isNaN(stepNumber) && stepUpdates.has(stepNumber)) {
      slide.body = stepUpdates.get(stepNumber)!;
      invalidatedStepNumbers.push(stepNumber);
    }
  }
  const existingNumbers = slides
    .map((slide) => Number.parseInt(slide.key, 10))
    .filter((stepNumber) => !Number.isNaN(stepNumber));
  let nextStepNumber = existingNumbers.length ? Math.max(...existingNumbers) + 1 : 1;
  for (const step of newSteps) {
    slides.push({ key: String(nextStepNumber), body: formatStepSlideBody(step) });
    nextStepNumber += 1;
  }
  return { content: serializeOpeningSlides(slides), invalidatedStepNumbers };
}
