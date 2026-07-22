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

const updateStepSchema = z
  .object({
    stepNumber: z.number().int().positive(),
    reason: z.string().min(1),
    introUpdate: z.string().optional(),
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
 * The five learning-plan proposal tools, given to the harness alongside its
 * read-only workspace tools. Descriptions mirror the legacy tool guidance so the
 * model uses them the same way.
 */
export function createPathforgePlanTools(): AgentTool[] {
  return [
    new PlanProposalTool(
      "update_step",
      "Flag a specific step as needing to change, with a clear reason — you do NOT write the new title/description yourself. Call when the learner asks to change a step, a step is clearly wrong, or you are self-correcting something that affects that step. Also check later steps that build on the same fact/tool and flag each that is now wrong. If the session overview also needs fixing, include introUpdate (written by you in full).",
      updateStepSchema as unknown as z.ZodType<Record<string, unknown>>,
    ),
    new PlanProposalTool(
      "regenerate_session",
      "RARE. Rebuild the entire session plan (intro + every step) because a foundational assumption changed broadly (environment/tooling swapped, architecture pivoted). For a single wrong step use update_step instead.",
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
