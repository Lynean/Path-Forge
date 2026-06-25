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
  RevisePlanParams,
  RevisePlanBody,
  RevisePlanResponse,
  GetNodeOpeningMessageParams,
  SpawnExtraNodeParams,
  SpawnExtraNodeBody,
  SpawnExtraNodeResponse,
} from "@workspace/api-zod";
import { requireAuth, getAuthUserId } from "../lib/auth";
import { generateNodeMap } from "../lib/aiNodeMap";
import {
  streamNodeChatMessage,
  streamOpeningMessage,
  classifyExtraNodeNeeded,
  generateNodeSummary,
  generateSpawnedNode,
  revisePlanNodes,
  type ChatMessage,
} from "../lib/aiNodeChat";

const router: IRouter = Router();

async function getMapContext(mapId: number) {
  const allNodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, mapId)).orderBy(nodesTable.createdAt);
  const nodeIds = allNodes.map((n) => n.id);
  const allEdges = nodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
    : [];
  return { allNodes, allEdges };
}

async function getOrCreateChatSession(nodeId: number) {
  const [existing] = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.nodeId, nodeId));
  if (existing) return existing;
  const [created] = await db.insert(chatSessionsTable).values({ nodeId, messages: [] }).returning();
  return created;
}

async function getRecentConcerns(excludeNodeId: number, mapId: number): Promise<string[]> {
  const otherNodes = await db
    .select()
    .from(nodesTable)
    .where(and(eq(nodesTable.mapId, mapId), eq(nodesTable.status, "completed")))
    .orderBy(nodesTable.updatedAt)
    .limit(5);

  const concerns: string[] = [];
  for (const n of otherNodes) {
    if (n.id === excludeNodeId) continue;
    const session = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.nodeId, n.id));
    if (!session[0]) continue;
    const msgs = (Array.isArray(session[0].messages) ? session[0].messages : []) as ChatMessage[];
    const userMsgs = msgs.filter((m) => m.role === "user").slice(-2);
    for (const m of userMsgs) {
      if (m.content.length > 20) concerns.push(m.content.slice(0, 200));
    }
    if (concerns.length >= 6) break;
  }
  return concerns.slice(0, 6);
}

router.post("/projects/:projectId/generate-map", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GenerateNodeMapParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));

  let aiResult;
  try {
    aiResult = await generateNodeMap(project, profile ?? null);
  } catch (err: any) {
    res.status(500).json({ error: `AI generation failed: ${err?.message ?? "Unknown error"}` });
    return;
  }

  await db.transaction(async (tx) => {
    const [existingMap] = await tx.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));

    let mapId: number;
    if (existingMap) {
      await tx.delete(nodeEdgesTable).where(
        inArray(nodeEdgesTable.fromNodeId,
          tx.select({ id: nodesTable.id }).from(nodesTable).where(eq(nodesTable.mapId, existingMap.id)))
      );
      await tx.delete(nodesTable).where(eq(nodesTable.mapId, existingMap.id));
      await tx.update(nodeMapsTable)
        .set({ rawJson: JSON.stringify(aiResult), updatedAt: new Date().toISOString() })
        .where(eq(nodeMapsTable.id, existingMap.id));
      mapId = existingMap.id;
    } else {
      const [newMap] = await tx.insert(nodeMapsTable)
        .values({ projectId: params.data.projectId, rawJson: JSON.stringify(aiResult) })
        .returning();
      mapId = newMap.id;
    }

    const aiIdToDbId = new Map<string, number>();
    for (const aiNode of aiResult.nodes) {
      const [insertedNode] = await tx.insert(nodesTable).values({
        mapId,
        title: aiNode.title,
        brief: aiNode.brief,
        status: aiNode.status,
        isExtra: aiNode.is_extra,
      }).returning();
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

    await tx.update(projectsTable).set({ status: "active" }).where(eq(projectsTable.id, params.data.projectId));
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
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const parsed = UpdateNodeStatusBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const [node] = await db.select().from(nodesTable)
    .where(and(eq(nodesTable.id, params.data.nodeId), eq(nodesTable.mapId, map.id)));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  if (node.status === "locked") {
    res.status(400).json({ error: "Cannot complete a locked node" });
    return;
  }

  let summary = parsed.data.summary ?? null;

  if (parsed.data.status === "completed" && !summary) {
    try {
      const session = await getOrCreateChatSession(node.id);
      const history = (Array.isArray(session.messages) ? session.messages : []) as ChatMessage[];
      summary = await generateNodeSummary(node, project, history);
    } catch {
      summary = `Completed ${node.title}`;
    }
  }

  await db.update(nodesTable)
    .set({ status: parsed.data.status, summary })
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

router.get("/projects/:projectId/nodes/:nodeId/chat", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetNodeChatParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

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

router.post("/projects/:projectId/nodes/:nodeId/opening-message", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetNodeOpeningMessageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const [node] = await db.select().from(nodesTable)
    .where(and(eq(nodesTable.id, params.data.nodeId), eq(nodesTable.mapId, map.id)));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));
  const { allNodes, allEdges } = await getMapContext(map.id);
  const recentConcerns = await getRecentConcerns(node.id, map.id);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  let fullContent = "";
  try {
    for await (const chunk of streamOpeningMessage(node, project, profile ?? null, { allNodes, allEdges }, recentConcerns)) {
      fullContent += chunk;
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    const session = await getOrCreateChatSession(node.id);
    const existing = (Array.isArray(session.messages) ? session.messages : []) as ChatMessage[];

    if (existing.length === 0) {
      const newMessages: ChatMessage[] = [
        { role: "assistant", content: fullContent, createdAt: new Date().toISOString() },
      ];
      await db.update(chatSessionsTable)
        .set({ messages: newMessages as any, updatedAt: new Date().toISOString() })
        .where(eq(chatSessionsTable.nodeId, node.id));
    }

    res.write("data: [DONE]\n\n");
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err?.message ?? "Stream error" })}\n\n`);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
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
  const { allNodes, allEdges } = await getMapContext(map.id);
  const recentConcerns = await getRecentConcerns(node.id, map.id);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  let fullContent = "";
  try {
    for await (const chunk of streamNodeChatMessage(
      node, project, profile ?? null, history, body.data.content, { allNodes, allEdges }, recentConcerns
    )) {
      fullContent += chunk;
      res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
    }

    const newMessages: ChatMessage[] = [
      ...history,
      { role: "user" as const, content: body.data.content, createdAt: new Date().toISOString() },
      { role: "assistant" as const, content: fullContent, createdAt: new Date().toISOString() },
    ];

    await db.update(chatSessionsTable)
      .set({ messages: newMessages as any, updatedAt: new Date().toISOString() })
      .where(eq(chatSessionsTable.nodeId, node.id));

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);

    try {
      const classification = await classifyExtraNodeNeeded(
        node, body.data.content, fullContent, { allNodes, allEdges }
      );

      if (classification.needed && classification.topic) {
        const spawned = await generateSpawnedNode(node, project, profile ?? null, classification.topic);
        const [newNode] = await db.insert(nodesTable).values({
          mapId: map.id,
          title: spawned.title,
          brief: spawned.brief,
          status: "available",
          isExtra: true,
        }).returning();
        await db.insert(nodeEdgesTable).values({ fromNodeId: node.id, toNodeId: newNode.id });
        res.write(`data: ${JSON.stringify({ type: "extra_node_spawned", nodeId: newNode.id, title: spawned.title })}\n\n`);
      }
    } catch {
    }
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err?.message ?? "Stream error" })}\n\n`);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

router.post("/projects/:projectId/nodes/:nodeId/spawn", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const nodeParams = SpawnExtraNodeParams.safeParse(req.params);
  if (!nodeParams.success) { res.status(400).json({ error: nodeParams.error.message }); return; }

  const body = SpawnExtraNodeBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, nodeParams.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, nodeParams.data.projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const [parentNode] = await db.select().from(nodesTable)
    .where(and(eq(nodesTable.id, nodeParams.data.nodeId), eq(nodesTable.mapId, map.id)));
  if (!parentNode) { res.status(404).json({ error: "Node not found" }); return; }

  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));

  let spawnedNode;
  try {
    spawnedNode = await generateSpawnedNode(parentNode, project, profile ?? null, body.data.topic);
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
  const edges = nodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
    : [];

  res.status(201).json(SpawnExtraNodeResponse.parse({ projectId: nodeParams.data.projectId, nodes: allNodes, edges }));
});

router.post("/projects/:projectId/revise-plan", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = RevisePlanParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const body = RevisePlanBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const { allNodes, allEdges } = await getMapContext(map.id);
  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));

  let aiResult;
  try {
    aiResult = await revisePlanNodes(project, profile ?? null, allNodes, allEdges, body.data.description);
  } catch (err: any) {
    res.status(500).json({ error: `AI revision failed: ${err?.message ?? "Unknown error"}` });
    return;
  }

  const completedNodes = allNodes.filter((n) => n.status === "completed");
  const futureNodes = allNodes.filter((n) => n.status !== "completed");

  const revisedIds = new Set(aiResult.revised_nodes.map((r) => r.id));
  const existingIdPattern = /^n(\d+)$/;

  const mentionedExistingIds = new Set<number>();
  for (const r of aiResult.revised_nodes) {
    const match = r.id.match(existingIdPattern);
    if (match) mentionedExistingIds.add(parseInt(match[1], 10));
  }

  const unmentionedFuture = futureNodes.filter((n) => !mentionedExistingIds.has(n.id));
  if (unmentionedFuture.length > 0) {
    const unmentionedIds = unmentionedFuture.map((n) => n.id);
    await db.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.toNodeId, unmentionedIds));
    await db.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, unmentionedIds));
    await db.delete(nodesTable).where(inArray(nodesTable.id, unmentionedIds));
  }

  const newIdMap = new Map<string, number>();

  for (const r of aiResult.revised_nodes) {
    const existMatch = r.id.match(existingIdPattern);
    if (existMatch) {
      const dbId = parseInt(existMatch[1], 10);
      const existing = futureNodes.find((n) => n.id === dbId);
      if (existing) {
        await db.update(nodesTable)
          .set({ title: r.title, brief: r.brief, updatedAt: new Date().toISOString() })
          .where(eq(nodesTable.id, dbId));
        newIdMap.set(r.id, dbId);
      }
    } else {
      const [inserted] = await db.insert(nodesTable).values({
        mapId: map.id,
        title: r.title,
        brief: r.brief,
        status: "locked",
        isExtra: false,
      }).returning();
      newIdMap.set(r.id, inserted.id);
    }
  }

  const affectedNodeIds = [...newIdMap.values()];
  if (affectedNodeIds.length > 0) {
    await db.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.toNodeId, affectedNodeIds));
  }

  for (const r of aiResult.revised_nodes) {
    const toId = newIdMap.get(r.id);
    if (!toId) continue;
    for (const prereqAiId of r.prerequisite_ids) {
      let fromId: number | undefined;
      const existMatch = prereqAiId.match(existingIdPattern);
      if (existMatch) {
        fromId = parseInt(existMatch[1], 10);
        if (!allNodes.find((n) => n.id === fromId)) fromId = undefined;
      } else {
        fromId = newIdMap.get(prereqAiId);
      }
      if (fromId) {
        await db.insert(nodeEdgesTable).values({ fromNodeId: fromId, toNodeId: toId });
      }
    }
  }

  const updatedNodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const updatedNodeIds = updatedNodes.map((n) => n.id);
  const updatedEdges = updatedNodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, updatedNodeIds))
    : [];

  res.json(RevisePlanResponse.parse({ projectId: params.data.projectId, nodes: updatedNodes, edges: updatedEdges }));
});

router.get("/projects/:projectId/map", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const projectId = parseInt(String(req.params.projectId ?? "0"), 10);
  if (!projectId) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const nodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const nodeIds = nodes.map((n) => n.id);
  const edges = nodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
    : [];

  res.json({ projectId, nodes, edges });
});

export default router;
