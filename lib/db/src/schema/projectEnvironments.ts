import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * A custom Docker environment the learner has APPROVED for a project (from an
 * agent proposal). Once approved, the tutor may build it and run the project's
 * commands in a locked sandbox. Local-desktop only; unused by the cloud app.
 */
export const projectEnvironmentsTable = pgTable("project_environments", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .unique()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  language: text("language"),
  baseImage: text("base_image").notNull(),
  setupCommands: jsonb("setup_commands").$type<string[]>().notNull().$default(() => []),
  runCommand: text("run_command").notNull(),
  dockerfile: text("dockerfile"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date().toISOString()),
});

export type ProjectEnvironment = typeof projectEnvironmentsTable.$inferSelect;
