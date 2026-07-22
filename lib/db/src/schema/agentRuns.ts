import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

/**
 * Durable record of one agent turn processed through the AgentRuntime seam
 * (legacy-via-adapter or harness). This is an append-only audit/telemetry trail,
 * kept separate from the conversation itself. It deliberately carries no foreign
 * keys to projects/nodes: run history should survive even if the underlying
 * project, node, or map is later deleted.
 */
export const agentRunsTable = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  clerkUserId: text("clerk_user_id").notNull(),
  projectId: integer("project_id"),
  nodeId: integer("node_id"),
  runtime: text("runtime").notNull(),
  status: text("status").notNull().default("running"),
  userMessage: text("user_message").notNull(),
  response: text("response"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
});

/**
 * Ordered event log for a run. Token-level `text_delta` events are intentionally
 * not persisted (too many, low signal); the final text lives on the run row.
 * `seq` gives a stable order even if inserts land out of order.
 */
export const agentRunEventsTable = pgTable("agent_run_events", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const insertAgentRunSchema = createInsertSchemaSafe();
export type AgentRun = typeof agentRunsTable.$inferSelect;
export type AgentRunEvent = typeof agentRunEventsTable.$inferSelect;

// Kept as a thin zod object rather than drizzle-zod to avoid coupling the audit
// insert shape to generated column defaults.
function createInsertSchemaSafe() {
  return z.object({
    runId: z.string().min(1),
    clerkUserId: z.string().min(1),
    projectId: z.number().int().nullable(),
    nodeId: z.number().int().nullable(),
    runtime: z.string().min(1),
    userMessage: z.string(),
  });
}
export type InsertAgentRun = z.infer<ReturnType<typeof createInsertSchemaSafe>>;
