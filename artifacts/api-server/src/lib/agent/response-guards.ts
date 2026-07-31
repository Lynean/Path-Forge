export interface ObservedToolCall {
  name: string;
  args: Record<string, unknown>;
}

const STEP_CORRECTION_TOOLS = new Set([
  "update_step_description",
  "regenerate_step_with_notes",
  "regenerate_session",
]);

export function usesStepCorrectionTool(toolCalls: ObservedToolCall[]): boolean {
  return toolCalls.some((toolCall) => STEP_CORRECTION_TOOLS.has(toolCall.name));
}

/**
 * A filename/path/etc. correction affects the remaining lesson plan, not just
 * the currently visible step.
 */
export function isCrossStepCorrectionReason(reason: string): boolean {
  return /\b(file(?:name)?|directory|folder|path|naming|name convention|rename|language|framework|tooling|architecture|everywhere|all steps)\b/i.test(
    reason,
  );
}

/**
 * A tutor may summarize a failed run badly. Keep its explanation, but append
 * the exact Python evidence whenever the model omitted it.
 */
export function groundTutorResponseInToolEvidence(
  response: string,
  toolCalls: ObservedToolCall[],
): string {
  const pythonRun = [...toolCalls]
    .reverse()
    .find((call) => call.name === "run_python");
  if (!pythonRun) return response;

  const error =
    typeof pythonRun.args.error === "string" ? pythonRun.args.error.trim() : "";
  const stderr =
    typeof pythonRun.args.stderr === "string" ? pythonRun.args.stderr.trim() : "";
  const evidence = error || stderr;
  if (!evidence || response.includes(evidence)) return response;

  const boundedEvidence =
    evidence.length > 6_000
      ? `${evidence.slice(0, 6_000)}\n… traceback shortened …`
      : evidence;
  const explanation = response.trim() || "The Python run failed with the evidence below.";
  return `${explanation}\n\n**Actual Python execution evidence**\n\n\`\`\`text\n${boundedEvidence}\n\`\`\``;
}
