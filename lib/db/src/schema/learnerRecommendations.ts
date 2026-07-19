import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export interface StoredProjectRecommendation {
  title: string;
  description: string;
  category: string;
}

// One row per learner — the ~10 AI-generated project ideas shown on the dashboard.
// Persisted so they survive across app opens/devices and only change when the learner
// explicitly asks for new ideas, instead of regenerating (and paying for an AI call) on
// every dashboard visit.
export const learnerRecommendationsTable = pgTable("learner_recommendations", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  recommendations: jsonb("recommendations").$type<StoredProjectRecommendation[]>().notNull().$default(() => []),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date().toISOString()),
});

export type LearnerRecommendations = typeof learnerRecommendationsTable.$inferSelect;
