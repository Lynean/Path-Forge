import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const learnerProfilesTable = pgTable("learner_profiles", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  age: integer("age"),
  educationLevel: text("education_level"),
  major: text("major"),
  interests: text("interests").notNull().default(""),
  experience: text("experience").notNull().default(""),
  preferredLanguage: text("preferred_language"),
  isComplete: boolean("is_complete").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow().$onUpdate(() => new Date().toISOString()),
});

export const insertLearnerProfileSchema = createInsertSchema(learnerProfilesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLearnerProfile = z.infer<typeof insertLearnerProfileSchema>;
export type LearnerProfile = typeof learnerProfilesTable.$inferSelect;
