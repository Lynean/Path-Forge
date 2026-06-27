import { Router, type IRouter } from "express";
import { eq, and, count, sql, inArray } from "drizzle-orm";
import { db, projectsTable, nodeMapsTable, nodesTable, nodeEdgesTable, learnerProfilesTable, chatSessionsTable, projectCodeContextTable } from "@workspace/db";
import {
  CreateProjectBody,
  CreateProjectResponse,
  GetProjectParams,
  GetProjectResponse,
  UpdateProjectParams,
  UpdateProjectBody,
  UpdateProjectResponse,
  DeleteProjectParams,
  ListProjectsResponse,
  GetProjectStatsParams,
  GetProjectStatsResponse,
  GetNodeMapParams,
  GetNodeMapResponse,
} from "@workspace/api-zod";
import { requireAuth, getAuthUserId } from "../lib/auth";
import { generateFramingQuestions, generateRefinedDescription } from "../lib/aiNodeMap";

const router: IRouter = Router();

router.post("/projects/refine-description", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const { title, ideaPrompt, qa } = req.body as {
    title?: string;
    ideaPrompt?: string;
    qa?: { question: string; answer: string }[];
  };
  if (!title?.trim() || !ideaPrompt?.trim() || !Array.isArray(qa) || qa.length === 0) {
    res.status(400).json({ error: "title, ideaPrompt, and qa are required" });
    return;
  }
  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));
  try {
    const refined = await generateRefinedDescription(title, ideaPrompt, qa, profile ?? null);
    res.json({ description: refined });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to refine description" });
  }
});

router.post("/projects/frame-questions", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const { title, ideaPrompt } = req.body as { title?: string; ideaPrompt?: string };
  if (!title?.trim() || !ideaPrompt?.trim()) {
    res.status(400).json({ error: "title and ideaPrompt are required" });
    return;
  }
  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));
  try {
    const result = await generateFramingQuestions(title, ideaPrompt, profile ?? null);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to generate questions" });
  }
});

router.get("/projects", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.clerkUserId, userId))
    .orderBy(projectsTable.updatedAt);
  res.json(ListProjectsResponse.parse(projects));
});

router.post("/projects", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [project] = await db
    .insert(projectsTable)
    .values({
      clerkUserId: userId,
      title: parsed.data.title,
      ideaPrompt: parsed.data.ideaPrompt,
      status: "draft",
    })
    .returning();

  res.status(201).json(CreateProjectResponse.parse(project));
});

router.get("/projects/:projectId", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(GetProjectResponse.parse(project));
});

router.patch("/projects/:projectId", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = UpdateProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [project] = await db
    .update(projectsTable)
    .set(parsed.data)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json(UpdateProjectResponse.parse(project));
});

router.delete("/projects/:projectId", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.sendStatus(404); return; }

  await db.transaction(async (tx) => {
    const [map] = await tx.select({ id: nodeMapsTable.id }).from(nodeMapsTable).where(eq(nodeMapsTable.projectId, project.id));

    if (map) {
      const nodes = await tx.select({ id: nodesTable.id }).from(nodesTable).where(eq(nodesTable.mapId, map.id));
      const nodeIds = nodes.map((n) => n.id);

      if (nodeIds.length > 0) {
        await tx.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds));
        await tx.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.toNodeId, nodeIds));
        await tx.delete(chatSessionsTable).where(inArray(chatSessionsTable.nodeId, nodeIds));
        await tx.delete(nodesTable).where(inArray(nodesTable.id, nodeIds));
      }

      await tx.delete(nodeMapsTable).where(eq(nodeMapsTable.id, map.id));
    }

    await tx.delete(projectCodeContextTable).where(eq(projectCodeContextTable.projectId, project.id));
    await tx.delete(projectsTable).where(eq(projectsTable.id, project.id));
  });

  res.sendStatus(204);
});

router.get("/projects/:projectId/stats", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetProjectStatsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [map] = await db
    .select()
    .from(nodeMapsTable)
    .where(eq(nodeMapsTable.projectId, params.data.projectId));

  if (!map) {
    res.json(GetProjectStatsResponse.parse({
      projectId: params.data.projectId,
      totalNodes: 0,
      completedNodes: 0,
      availableNodes: 0,
      extraNodes: 0,
      progressPercent: 0,
    }));
    return;
  }

  const nodes = await db
    .select()
    .from(nodesTable)
    .where(eq(nodesTable.mapId, map.id));

  const totalNodes = nodes.length;
  const completedNodes = nodes.filter(n => n.status === "completed").length;
  const availableNodes = nodes.filter(n => n.status === "available").length;
  const extraNodes = nodes.filter(n => n.isExtra).length;
  const progressPercent = totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0;

  res.json(GetProjectStatsResponse.parse({
    projectId: params.data.projectId,
    totalNodes,
    completedNodes,
    availableNodes,
    extraNodes,
    progressPercent,
  }));
});

router.get("/projects/:projectId/map", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetNodeMapParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [map] = await db
    .select()
    .from(nodeMapsTable)
    .where(eq(nodeMapsTable.projectId, params.data.projectId));

  if (!map) {
    res.status(404).json({ error: "Node map not found" });
    return;
  }

  const nodes = await db
    .select()
    .from(nodesTable)
    .where(eq(nodesTable.mapId, map.id))
    .orderBy(nodesTable.createdAt);

  const nodeIds = nodes.map(n => n.id);
  let edges: { id: number; fromNodeId: number; toNodeId: number }[] = [];
  if (nodeIds.length > 0) {
    edges = await db
      .select()
      .from(nodeEdgesTable)
      .where(sql`${nodeEdgesTable.fromNodeId} = ANY(${sql.raw(`ARRAY[${nodeIds.join(",")}]`)})`)
  }

  res.json(GetNodeMapResponse.parse({
    projectId: params.data.projectId,
    nodes,
    edges,
  }));
});

export default router;
