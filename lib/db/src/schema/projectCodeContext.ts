import { pgTable, serial, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

export interface CodeFile {
  filename: string;
  description: string;
  content: string;
  changeLog: Array<{
    note: string;
    reason: string;
    timestamp: string;
  }>;
}

export const projectCodeContextTable = pgTable("project_code_context", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().unique(),
  files: jsonb("files").$type<CodeFile[]>().notNull().$default(() => []),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date().toISOString()),
});

export type ProjectCodeContext = typeof projectCodeContextTable.$inferSelect;
