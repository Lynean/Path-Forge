import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, projectsTable, nodeMapsTable, nodesTable, nodeEdgesTable, chatSessionsTable, learnerProfilesTable } from "@workspace/db";
import {
  GenerateNodeMapParams,
  GenerateNodeMapResponse,
  UpdateNodeStatusParams,
  UpdateNodeStatusBody,
  UpdateNodeStatusResponse,
  GetNodeChatParams,
  GetNodeChatResponse,
  SendNodeChatMessageParams,
  SendNodeChatMessageBody,
} from "@workspace/api-zod";
import { requireAuth, getAuthUserId } from "../lib/auth";
import { generateNodeMap } from "../lib/aiNodeMap";
import { streamNodeChatMessage, generateSpawnedNode, type ChatMessage } from "../lib/aiNodeChat";

const router: IRouter = Router();

router.post("/projects/:projectId/generate-map", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GenerateNodeMapParams.safeParse(req.params);
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

  const [profile] = await db
    .select()
    .from(learnerProfilesTable)
    .where(eq(learnerProfilesTable.clerkUserId, userId));

  let aiResult;
  try {
    aiResult = await generateNodeMap(project, profile ?? null);
  } catch (err: any) {
    res.status(500).json({ error: `AI generation failed: ${err?.message ?? "Unknown error"}` });
    return;
  }

  await db.transaction(async (tx) => {
    const [existingMap] = await tx
      .select()
      .from(nodeMapsTable)
      .where(eq(nodeMapsTable.projectId, params.data.projectId));

    let mapId: number;
    if (existingMap) {
      await tx.delete(nodeEdgesTable).where(
        inArray(
          nodeEdgesTable.fromNodeId,
          tx.select({ id: nodesTable.id }).from(nodesTable).where(eq(nodesTable.mapId, existingMap.id))
        )
      );
      await tx.delete(nodesTable).where(eq(nodesTable.mapId, existingMap.id));
      await tx.update(nodeMapsTable)
        .set({ rawJson: JSON.stringify(aiResult), updatedAt: new Date().toISOString() })
        .where(eq(nodeMapsTable.id, existingMap.id));
      mapId = existingMap.id;
    } else {
      const [newMap] = await tx
        .insert(nodeMapsTable)
        .values({ projectId: params.data.projectId, rawJson: JSON.stringify(aiResult) })
        .returning();
      mapId = newMap.id;
    }

    const aiIdToDbId = new Map<string, number>();

    for (const aiNode of aiResult.nodes) {
      const [insertedNode] = await tx
        .insert(nodesTable)
        .values({
          mapId,
          title: aiNode.title,
          brief: aiNode.brief,
          status: aiNode.status,
          isExtra: aiNode.is_extra,
        })
        .returning();
      aiIdToDbId.set(aiNode.id, insertedNode.id);
    }

    for (const aiNode of aiResult.nodes) {
      const toNodeId = aiIdToDbId.get(aiNode.id);
      if (!toNodeId) continue;
      for (const prereqId of aiNode.prerequisite_ids) {
        const fromNodeId = aiIdToDbId.get(prereqId);
        if (!fromNodeId) continue;
        await tx.insert(nodeEdgesTable).values({ fromNodeId, toNodeId });
      }
    }

    await tx
      .update(projectsTable)
      .set({ status: "active" })
      .where(eq(projectsTable.id, params.data.projectId));
  });

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));
  const nodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const nodeIds = nodes.map((n) => n.id);
  const edges = nodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
    : [];

  res.json(GenerateNodeMapResponse.parse({ projectId: params.data.projectId, nodes, edges }));
});

router.patch("/projects/:projectId/nodes/:nodeId", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = UpdateNodeStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateNodeStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));
  if (!map) {
    res.status(404).json({ error: "Node map not found" });
    return;
  }

  const [node] = await db
    .select()
    .from(nodesTable)
    .where(and(eq(nodesTable.id, params.data.nodeId), eq(nodesTable.mapId, map.id)));

  if (!node) {
    res.status(404).json({ error: "Node not found" });
    return;
  }

  await db
    .update(nodesTable)
    .set({ status: parsed.data.status })
    .where(eq(nodesTable.id, params.data.nodeId));

  if (parsed.data.status === "completed") {
    const allNodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id));
    const allEdges = await db.select().from(nodeEdgesTable).where(
      inArray(nodeEdgesTable.fromNodeId, allNodes.map((n) => n.id))
    );

    const completedIds = new Set(
      allNodes.filter((n) => n.id === params.data.nodeId ? true : n.status === "completed").map((n) => n.id)
    );

    for (const n of allNodes) {
      if (n.status !== "locked") continue;
      const prereqs = allEdges.filter((e) => e.toNodeId === n.id).map((e) => e.fromNodeId);
      const allPrereqsDone = prereqs.every((pid) => completedIds.has(pid));
      if (allPrereqsDone && prereqs.length > 0) {
        await db.update(nodesTable).set({ status: "available" }).where(eq(nodesTable.id, n.id));
      }
    }

    const allCompleted = allNodes.every((n) =>
      n.id === params.data.nodeId ? true : n.status === "completed"
    );
    if (allCompleted) {
      await db.update(projectsTable).set({ status: "completed" }).where(eq(projectsTable.id, params.data.projectId));
    }
  }

  const updatedNodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const nodeIds = updatedNodes.map((n) => n.id);
  const edges = nodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
    : [];

  res.json(UpdateNodeStatusResponse.parse({ projectId: params.data.projectId, nodes: updatedNodes, edges }));
});

async function getOrCreateChatSession(nodeId: number) {
  const [existing] = await db
    .select()
    .from(chatSessionsTable)
    .where(eq(chatSessionsTable.nodeId, nodeId));
  if (existing) return existing;
  const [created] = await db
    .insert(chatSessionsTable)
    .values({ nodeId, messages: [] })
    .returning();
  return created;
}

router.get("/projects/:projectId/nodes/:nodeId/chat", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetNodeChatParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const [node] = await db.select().from(nodesTable)
    .where(and(eq(nodesTable.id, params.data.nodeId), eq(nodesTable.mapId, map.id)));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const session = await getOrCreateChatSession(node.id);
  const messages = Array.isArray(session.messages) ? session.messages : [];

  res.json(GetNodeChatResponse.parse({ nodeId: node.id, messages }));
});

router.post("/projects/:projectId/nodes/:nodeId/chat", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = SendNodeChatMessageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const body = SendNodeChatMessageBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const [node] = await db.select().from(nodesTable)
    .where(and(eq(nodesTable.id, params.data.nodeId), eq(nodesTable.mapId, map.id)));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));

  const session = await getOrCreateChatSession(node.id);
  const history = (Array.isArray(session.messages) ? session.messages : []) as ChatMessage[];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let fullContent = "";

  try {
    for await (const chunk of streamNodeChatMessage(node, project, profile ?? null, history, body.data.content)) {
      fullContent += chunk;
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    const newMessages: ChatMessage[] = [
      ...history,
      { role: "user" as const, content: body.data.content, createdAt: new Date().toISOString() },
      { role: "assistant" as const, content: fullContent, createdAt: new Date().toISOString() },
    ];

    await db.update(chatSessionsTable)
      .set({ messages: newMessages as any, updatedAt: new Date().toISOString() })
      .where(eq(chatSessionsTable.nodeId, node.id));

    res.write("data: [DONE]\n\n");
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err?.message ?? "Stream error" })}\n\n`);
  } finally {
    res.end();
  }
});

router.post("/projects/:projectId/nodes/:nodeId/spawn", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const projectId = parseInt(String(req.params.projectId ?? "0"), 10);
  const nodeId = parseInt(String(req.params.nodeId ?? "0"), 10);

  if (!projectId || !nodeId) { res.status(400).json({ error: "Invalid params" }); return; }

  const body = req.body as { topic?: string };
  if (!body.topic?.trim()) { res.status(400).json({ error: "topic is required" }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const [parentNode] = await db.select().from(nodesTable)
    .where(and(eq(nodesTable.id, nodeId), eq(nodesTable.mapId, map.id)));
  if (!parentNode) { res.status(404).json({ error: "Node not found" }); return; }

  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));

  let spawnedNode;
  try {
    spawnedNode = await generateSpawnedNode(parentNode, project, profile ?? null, body.topic);
  } catch (err: any) {
    res.status(500).json({ error: `AI spawn failed: ${err?.message}` });
    return;
  }

  const [newNode] = await db.insert(nodesTable).values({
    mapId: map.id,
    title: spawnedNode.title,
    brief: spawnedNode.brief,
    status: "available",
    isExtra: true,
  }).returning();

  await db.insert(nodeEdgesTable).values({ fromNodeId: parentNode.id, toNodeId: newNode.id });

  const allNodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const nodeIds = allNodes.map((n) => n.id);
  const edges = nodeIds.length > 0 ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds)) : [];

  res.status(201).json({ projectId, nodes: allNodes, edges });
});

export default router;
