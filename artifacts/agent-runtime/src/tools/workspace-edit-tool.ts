import { z } from "zod/v4";
import type { SandboxManager } from "../sandbox/sandbox-manager";
import type { WorkspaceAccess } from "../workspace/workspace-access";
import type { AgentTool, AgentToolContext } from "./tool";

/**
 * Stages one exact text replacement. It never writes to the user's real workspace;
 * Docker receives the overlay only after the existing sandbox session is refreshed.
 */
export class ApplyPatchTool implements AgentTool {
  readonly name = "apply_patch";
  readonly description =
    "Stage one bounded workspace edit without changing the user's real files. For an existing file, oldText must be an exact unique block copied from read_file. For a new file, use oldText=null. The result contains a diff preview.";
  readonly inputSchema = z
    .object({
      path: z.string().min(1).max(500),
      oldText: z.string().min(1).max(100_000).nullable(),
      newText: z.string().max(200_000),
    })
    .strict();
  private readonly patchAttempts = new Map<string, number>();

  constructor(
    private readonly workspace: WorkspaceAccess,
    private readonly sandboxes?: SandboxManager,
    private readonly maxPatchesPerRun = 3,
  ) {}

  invalidatesPriorToolResults(output: unknown): boolean {
    return (
      Boolean(output) &&
      typeof output === "object" &&
      (output as Record<string, unknown>)["staged"] === true
    );
  }

  async execute(
    arguments_: Record<string, unknown>,
    context?: AgentToolContext,
  ): Promise<unknown> {
    const runId = context?.runId ?? "__standalone__";
    const attempts = this.patchAttempts.get(runId) ?? 0;
    if (attempts >= this.maxPatchesPerRun) {
      return {
        ok: false,
        error: "REPAIR_BUDGET_EXCEEDED",
        reason: `This run may stage at most ${this.maxPatchesPerRun} repair patches.`,
        attempts,
      };
    }
    const result = await this.workspace.stageTextReplacement(
      arguments_["path"] as string,
      arguments_["oldText"] as string | null,
      arguments_["newText"] as string,
    );
    this.patchAttempts.set(runId, attempts + 1);
    if (context && this.sandboxes) await this.sandboxes.refreshRun(context.runId);
    return {
      ok: true,
      staged: true,
      hostWorkspaceChanged: false,
      ...result,
      stagedFileCount: this.workspace.stagedEdits().length,
      repairAttemptsRemaining: this.maxPatchesPerRun - attempts - 1,
    };
  }

  async finishRun(runId: string): Promise<void> {
    this.patchAttempts.delete(runId);
  }
}
