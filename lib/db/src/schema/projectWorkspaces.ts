import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * The learner's real local project folder attached to a project (fully-local
 * desktop). When set, the harness runtime operates on this folder directly —
 * reading real files and running commands in a sandbox — instead of the DB code
 * snippets. Only meaningful on-device; unused by the cloud web app.
 */
export const projectWorkspacesTable = pgTable("project_workspaces", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .unique()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date().toISOString()),
});

export type ProjectWorkspace = typeof projectWorkspacesTable.$inferSelect;
