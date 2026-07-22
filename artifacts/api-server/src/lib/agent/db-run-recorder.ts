import { eq } from "drizzle-orm";
import { db, agentRunsTable, agentRunEventsTable } from "@workspace/db";
import type { AgentEvent, AgentTurnInput } from "@workspace/agent-runtime";
import type { RunRecorder } from "./persistent-runtime";

export interface RunMetadata {
  clerkUserId: string;
  projectId: number | null;
  nodeId: number | null;
  runtime: string;
  userMessage: string;
}

/** Postgres-backed {@link RunRecorder} writing to the agent_runs tables. */
export class DbRunRecorder implements RunRecorder {
  constructor(private readonly meta: RunMetadata) {}

  async startRun(input: AgentTurnInput): Promise<void> {
    await db
      .insert(agentRunsTable)
      .values({
        runId: input.runId,
        clerkUserId: this.meta.clerkUserId,
        projectId: this.meta.projectId,
        nodeId: this.meta.nodeId,
        runtime: this.meta.runtime,
        status: "running",
        userMessage: this.meta.userMessage,
      })
      .onConflictDoNothing({ target: agentRunsTable.runId });
  }

  async recordEvent(runId: string, seq: number, event: AgentEvent): Promise<void> {
    const { type, ...payload } = event as { type: string } & Record<string, unknown>;
    await db.insert(agentRunEventsTable).values({ runId, seq, type, payload });
  }

  async finishRun(runId: string, status: string, response: string | null): Promise<void> {
    await db
      .update(agentRunsTable)
      .set({ status, response, completedAt: new Date().toISOString() })
      .where(eq(agentRunsTable.runId, runId));
  }
}
