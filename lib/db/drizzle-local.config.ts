import { defineConfig } from "drizzle-kit";

// Config for generating SQL migrations from the schema (no live DB needed).
// The embedded PGlite database applies these at startup; the same Postgres
// dialect SQL also matches the cloud Postgres schema.
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
});
