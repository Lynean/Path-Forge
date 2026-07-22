/**
 * Verifies the embedded local database path (fully-local desktop): PATHFORGE_LOCAL_DB
 * selects PGlite, migrations create the schema, and the same DbRunRecorder used
 * for cloud Postgres works unchanged. No cloud DB, no network.
 *
 *   pnpm --filter @workspace/api-server run agent:verify-local-db
 */
process.env.PATHFORGE_LOCAL_DB = process.env.PATHFORGE_LOCAL_DB || ":memory:";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("Embedded local database (PGlite) verification\n");

  // Dynamic imports so PATHFORGE_LOCAL_DB is set before @workspace/db loads.
  const { db, agentRunsTable, agentRunEventsTable, initLocalDatabase, isLocalDatabase } =
    await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const { DbRunRecorder } = await import("./db-run-recorder");

  check("running against the embedded local database", isLocalDatabase === true);

  await initLocalDatabase(); // applies generated migrations → creates all tables

  const recorder = new DbRunRecorder({
    clerkUserId: "local", projectId: 1, nodeId: 2, runtime: "harness", userMessage: "hi",
  });
  await recorder.startRun({
    runId: "fl-1", workspaceId: "w", preferredLanguage: null,
    currentNode: { id: 2, title: "t" }, messages: [], userMessage: "hi",
  });
  await recorder.recordEvent("fl-1", 0, { type: "run_started", runId: "fl-1" });
  await recorder.recordEvent("fl-1", 1, {
    type: "tool_completed", tool: "spawn_node", output: { title: "T", brief: "B" },
  });
  await recorder.finishRun("fl-1", "completed", "done");

  const [run] = await db.select().from(agentRunsTable).where(eq(agentRunsTable.runId, "fl-1"));
  const events = await db.select().from(agentRunEventsTable).where(eq(agentRunEventsTable.runId, "fl-1"));

  check("migrations created the schema and the run round-trips", run?.status === "completed" && run?.response === "done", JSON.stringify(run));
  check("timestamps come back as ISO strings", typeof run?.createdAt === "string");
  check("jsonb payload round-trips", events.length === 2 && (events[1].payload as { output?: { title?: string } }).output?.title === "T", JSON.stringify(events.map((e) => e.payload)));

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
