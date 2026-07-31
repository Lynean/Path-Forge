import { z } from "zod/v4";
import type { AgentTool } from "@workspace/agent-runtime";

/**
 * PathForge learning-plan tools for the harness runtime. They mirror the legacy
 * `aiNodeChat` tool contract (names + argument shapes) exactly, but their job is
 * only to *propose* an action: `execute()` validates the arguments and echoes
 * them back as structured evidence. No database write happens here — the harness
 * stays outside the DB trust boundary. The chat route's existing tool tail is
 * the trusted code that validates ownership/DAG rules and applies the change,
 * identically for the legacy and harness runtimes.
 */
class PlanProposalTool implements AgentTool {
  constructor(
    public readonly name: string,
    public readonly description: string,
    public readonly inputSchema: z.ZodType<Record<string, unknown>>,
  ) {}

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    // Validate/coerce; the parsed object is both the model's observation and the
    // proposal the route reads from the resulting `tool_completed` event.
    const proposal = this.inputSchema.parse(arguments_);
    return { recorded: true, ...proposal };
  }
}

const updateStepDescriptionSchema = z
  .object({
    stepNumber: z.number().int().positive(),
    reason: z.string().min(1),
    introUpdate: z.string().optional(),
  })
  .strict();

const regenerateStepWithNotesSchema = z
  .object({
    stepNumber: z.number().int().positive(),
    issueNote: z.string().min(1),
  })
  .strict();

const regenerateSessionSchema = z.object({ reason: z.string().min(1) }).strict();

const addStepsSchema = z
  .object({
    steps: z
      .array(z.object({ title: z.string().min(1), description: z.string().min(1) }).strict())
      .min(1),
  })
  .strict();

const spawnNodeSchema = z
  .object({ title: z.string().min(1), brief: z.string().min(1) })
  .strict();

const markStepsDoneSchema = z
  .object({ stepNumbers: z.array(z.number().int().positive()).min(1) })
  .strict();

/**
 * The six learning-plan proposal tools, given to the harness alongside its
 * read-only workspace tools. Descriptions mirror the legacy tool guidance so the
 * model uses them the same way.
 */
export function createPathforgePlanTools(): AgentTool[] {
  return [
    new PlanProposalTool(
      "update_step_description",
      "Use ONLY when a step's visible title or short description states the wrong goal or scope. Call proactively when the learner reports it; they do not need to explicitly request an update. A dedicated pass rewrites title/description while preserving DONE/NEXT. Keep the text reply to one short sentence.",
      updateStepDescriptionSchema as unknown as z.ZodType<Record<string, unknown>>,
    ),
    new PlanProposalTool(
      "regenerate_step_with_notes",
      "Use when title/description are correct but the detailed content or code is wrong, incomplete, contradicts an earlier step, removes prior code, or changes established identifiers. Preserve title/description and DONE/NEXT; issueNote guides regeneration. Call proactively when the learner reflects the issue and keep the text reply to one short sentence.",
      regenerateStepWithNotesSchema as unknown as z.ZodType<Record<string, unknown>>,
    ),
    new PlanProposalTool(
      "regenerate_session",
      "RARE. Rebuild the entire session plan because a foundational assumption changed broadly. For one wrong step use update_step_description or regenerate_step_with_notes.",
      regenerateSessionSchema as unknown as z.ZodType<Record<string, unknown>>,
    ),
    new PlanProposalTool(
      "add_steps",
      "Append new steps to the end of the current session because you identified steps that are missing.",
      addStepsSchema as unknown as z.ZodType<Record<string, unknown>>,
    ),
    new PlanProposalTool(
      "spawn_node",
      "Create a new, separate learning node for a distinct topic the learner raised that isn't covered anywhere in the existing map. The new node generates its own opening session. Call at most twice per response.",
      spawnNodeSchema as unknown as z.ZodType<Record<string, unknown>>,
    ),
    new PlanProposalTool(
      "mark_steps_done",
      "Mark one or more mini-steps from the Session Checklist as completed because the learner demonstrated they implemented, ran, and confirmed them working — not just because you explained them. Don't re-mark steps already shown as done.",
      markStepsDoneSchema as unknown as z.ZodType<Record<string, unknown>>,
    ),
  ];
}
