import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, agentRunsTable, agentRunEventsTable } from "@workspace/db";
import {
  ListAgentRunsQueryParams,
  ListAgentRunsResponse,
  GetAgentRunParams,
  GetAgentRunResponse,
} from "@workspace/api-zod";
import { requireAuth, getAuthUserId } from "../lib/auth";

const router: IRouter = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

router.get("/agent-runs", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const query = ListAgentRunsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const limit = Math.min(query.data.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const runs = await db
    .select()
    .from(agentRunsTable)
    .where(eq(agentRunsTable.clerkUserId, userId))
    .orderBy(desc(agentRunsTable.createdAt))
    .limit(limit);

  res.json(ListAgentRunsResponse.parse(runs));
});

router.get("/agent-runs/:runId", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetAgentRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Scope by clerkUserId so a run id alone never exposes another learner's run.
  const [run] = await db
    .select()
    .from(agentRunsTable)
    .where(and(eq(agentRunsTable.runId, params.data.runId), eq(agentRunsTable.clerkUserId, userId)));
  if (!run) {
    res.status(404).json({ error: "Agent run not found" });
    return;
  }

  const events = await db
    .select()
    .from(agentRunEventsTable)
    .where(eq(agentRunEventsTable.runId, run.runId))
    .orderBy(asc(agentRunEventsTable.seq));

  res.json(GetAgentRunResponse.parse({ run, events }));
});

export default router;
