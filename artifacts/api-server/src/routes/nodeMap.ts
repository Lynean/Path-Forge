import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, projectsTable, nodeMapsTable, nodesTable, nodeEdgesTable, chatSessionsTable, learnerProfilesTable, projectCodeContextTable } from "@workspace/db";
import type { CodeFile, Node as DbNode, NodeEdge } from "@workspace/db";
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
import { streamVisualization } from "../lib/aiVisualize";
import {
  streamNodeChatMessage,
  streamOpeningMessage,
  classifyExtraNodeNeeded,
  generateNodeSummary,
  generateSpawnedNode,
  revisePlanNodes,
  extractCodeContextUpdates,
  applyCodeContextUpdates,
  type ChatMessage,
} from "../lib/aiNodeChat";

async function getOrCreateCodeContext(projectId: number): Promise<{ id: number; files: CodeFile[] }> {
  const [existing] = await db.select().from(projectCodeContextTable).where(eq(projectCodeContextTable.projectId, projectId));
  if (existing) return { id: existing.id, files: (existing.files as CodeFile[]) ?? [] };
  const [created] = await db.insert(projectCodeContextTable).values({ projectId, files: [] as any }).returning();
  return { id: created.id, files: [] };
}

async function saveCodeContext(projectId: number, files: CodeFile[]): Promise<void> {
  await db.insert(projectCodeContextTable)
    .values({ projectId, files: files as any })
    .onConflictDoUpdate({
      target: projectCodeContextTable.projectId,
      set: { files: files as any, updatedAt: new Date().toISOString() },
    });
}

async function extractAndSaveFromMessages(
  projectId: number,
  nodeTitle: string,
  project: { title: string },
  messages: ChatMessage[]
): Promise<void> {
  const hasCode = (m: ChatMessage) => m.content.includes("```");
  if (!messages.some(hasCode)) return;

  const { files: currentFiles } = await getOrCreateCodeContext(projectId);
  let files = currentFiles;

  // Process pairs: for each assistant message with code, also check if the
  // preceding/following user message has code (user's own implementation).
  // User-pasted code is processed LAST so it overwrites AI suggestions.
  const assistantCodeMsgs = messages.filter((m) => m.role === "assistant" && hasCode(m)).slice(-5);
  const userCodeMsgs = messages.filter((m) => m.role === "user" && hasCode(m)).slice(-3);

  for (const msg of assistantCodeMsgs) {
    const idx = messages.indexOf(msg);
    const priorUserMsg = messages.slice(0, idx).filter((m) => m.role === "user").slice(-1)[0]?.content ?? "";
    const updates = await extractCodeContextUpdates(nodeTitle, project, priorUserMsg, msg.content, files);
    if (updates.length > 0) files = applyCodeContextUpdates(files, updates);
  }

  // User's own code always wins — overwrite whatever the AI suggested
  for (const msg of userCodeMsgs) {
    const updates = await extractCodeContextUpdates(nodeTitle, project, "", msg.content, files);
    if (updates.length > 0) {
      // Mark these as user-authored in the change log
      const userUpdates = updates.map((u) => ({ ...u, changeNote: `[user] ${u.changeNote}`, reason: "user implementation" }));
      files = applyCodeContextUpdates(files, userUpdates);
    }
  }

  if (files !== currentFiles) {
    await saveCodeContext(projectId, files);
  }
}

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

function asksToRepositionCheckpoint(description: string): boolean {
  const text = description.toLowerCase();
  return (
    /(docker|caddy|validation|checkpoint)/.test(text) &&
    /(not.*first|first.*wrong|after|historical|out of order|checkpoint)/.test(text)
  );
}

async function repositionCompletedIntegrationCheckpoints(mapId: number, description: string): Promise<void> {
  if (!asksToRepositionCheckpoint(description)) return;

  const nodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, mapId));
  const checkpointNodes = nodes.filter((node) =>
    node.status === "completed" &&
    /(docker|caddy|validate|validation|https)/i.test(node.title)
  );
  if (checkpointNodes.length === 0) return;

  const upstreamNodes = nodes.filter((node) =>
    !checkpointNodes.some((checkpoint) => checkpoint.id === node.id) &&
    /(analy[sz]e|documentation|code|scaffold|rebuild|core|provision|import|activate|wire|workflow)/i.test(node.title) &&
    !/(docker|caddy|validate|validation|checkpoint|demonstrate|test|security|documentation$|final)/i.test(node.title)
  );
  if (upstreamNodes.length === 0) return;

  for (const checkpoint of checkpointNodes) {
    await db.delete(nodeEdgesTable).where(eq(nodeEdgesTable.fromNodeId, checkpoint.id));
    await db.delete(nodeEdgesTable).where(eq(nodeEdgesTable.toNodeId, checkpoint.id));

    for (const upstream of upstreamNodes) {
      await db.insert(nodeEdgesTable).values({
        fromNodeId: upstream.id,
        toNodeId: checkpoint.id,
      });
    }
  }
}

type OutcomeKey =
  | "nocodb"
  | "n8n-import"
  | "n8n-wire"
  | "docker"
  | "flow-demo"
  | "core-app"
  | "bpmview"
  | "playwright"
  | "unit-tests"
  | "ops-docs"
  | "security"
  | "refactor-deploy"
  | "final-testing";

const OUTCOME_PATTERNS: Array<{ key: OutcomeKey; pattern: RegExp }> = [
  { key: "nocodb", pattern: /\b(nocodb|data source|data-source|table provisioning|provision.*config)\b/i },
  { key: "n8n-import", pattern: /\b(import|activate|activation)\b.*\bn8n\b|\bn8n\b.*\b(import|activate|activation)\b/i },
  { key: "n8n-wire", pattern: /\b(wire|connect|workflow logic|transition logic|server-side block|bpm transition)\b.*\bn8n\b|\bn8n\b.*\b(wire|connect|logic|transition)\b/i },
  { key: "docker", pattern: /\b(docker|caddy|local https|development environment|dev environment)\b/i },
  { key: "flow-demo", pattern: /\b(demonstrate|demo|linear flow|threshold|matrix|escalation|exception flow|flow execution)\b/i },
  { key: "core-app", pattern: /\b(rebuild core|react\/vite|react|vite|application shell|feature-gated|rule engine framework)\b/i },
  { key: "bpmview", pattern: /\b(bpmview|inline form|iframe rendering|hashrouter form)\b/i },
  { key: "playwright", pattern: /\b(playwright|end-to-end|e2e|uat|live transition|block-rule)\b/i },
  { key: "unit-tests", pattern: /\b(vitest|unit test|rule evaluation test)\b/i },
  { key: "ops-docs", pattern: /\b(operations documentation|runbook|gotchas|deployment instructions|data migration|troubleshooting|docs\/)\b/i },
  { key: "security", pattern: /\b(security|hardening|admin token|server-side authentication|api proxy|secret)\b/i },
  { key: "refactor-deploy", pattern: /\b(refactor|reusability|deployment readiness|deployment preparation|finalize deployment|production deploy)\b/i },
  { key: "final-testing", pattern: /\b(final application|final assembly|final testing|cohesive starter|robust and deployable)\b/i },
];

function asksToCleanPlan(description: string): boolean {
  return /\b(clean|cleanup|dedupe|de-duplicate|duplicate|consolidate|align with the real implementation|real implementation|remaining path)\b/i.test(description);
}

function classifyOutcome(node: Pick<DbNode, "title" | "brief">): OutcomeKey | undefined {
  const text = `${node.title} ${node.brief}`;
  return OUTCOME_PATTERNS.find(({ pattern }) => pattern.test(text))?.key;
}

function descriptionMarksOutcomeComplete(description: string, key: OutcomeKey): boolean {
  const outcome = OUTCOME_PATTERNS.find((item) => item.key === key);
  if (!outcome || !outcome.pattern.test(description)) return false;
  return /\b(already completed|completed evidence|completed|done|verified|validated|created|exists|wired|expanded)\b/i.test(description);
}

function allowedRemainingOutcomes(description: string): Set<OutcomeKey> | null {
  if (!/remaining path should focus only|focus only on genuinely unfinished/i.test(description)) return null;

  const allowed = new Set<OutcomeKey>();
  if (/\bsecurity|hardening\b/i.test(description)) allowed.add("security");
  if (/\brefactor|deployment readiness|deployment preparation\b/i.test(description)) allowed.add("refactor-deploy");
  if (/\boperations documentation|documentation review|docs review|gap remains\b/i.test(description)) allowed.add("ops-docs");
  if (/\bfinal assembly|final testing|testing\b/i.test(description)) allowed.add("final-testing");
  return allowed;
}

function pickKeeper(nodes: DbNode[]): DbNode {
  return [...nodes].sort((a, b) => {
    if (a.status === "available" && b.status !== "available") return -1;
    if (b.status === "available" && a.status !== "available") return 1;
    return a.id - b.id;
  })[0];
}

async function deleteFutureNodesAndRewire(
  nodesToDelete: DbNode[],
  replacementByDeletedId: Map<number, number | undefined>,
  edges: NodeEdge[]
): Promise<void> {
  if (nodesToDelete.length === 0) return;

  const deletedIds = new Set(nodesToDelete.map((node) => node.id));
  const additions = new Map<string, { fromNodeId: number; toNodeId: number }>();

  for (const node of nodesToDelete) {
    const replacementId = replacementByDeletedId.get(node.id);
    const incoming = edges.filter((edge) => edge.toNodeId === node.id && !deletedIds.has(edge.fromNodeId));
    const outgoing = edges.filter((edge) => edge.fromNodeId === node.id && !deletedIds.has(edge.toNodeId));

    if (replacementId) {
      for (const edge of incoming) {
        if (edge.fromNodeId !== replacementId) {
          additions.set(`${edge.fromNodeId}:${replacementId}`, { fromNodeId: edge.fromNodeId, toNodeId: replacementId });
        }
      }
      for (const edge of outgoing) {
        if (replacementId !== edge.toNodeId) {
          additions.set(`${replacementId}:${edge.toNodeId}`, { fromNodeId: replacementId, toNodeId: edge.toNodeId });
        }
      }
    } else {
      for (const incomingEdge of incoming) {
        for (const outgoingEdge of outgoing) {
          if (incomingEdge.fromNodeId !== outgoingEdge.toNodeId) {
            additions.set(`${incomingEdge.fromNodeId}:${outgoingEdge.toNodeId}`, {
              fromNodeId: incomingEdge.fromNodeId,
              toNodeId: outgoingEdge.toNodeId,
            });
          }
        }
      }
    }
  }

  const deleteIds = [...deletedIds];
  await db.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.toNodeId, deleteIds));
  await db.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, deleteIds));
  await db.delete(nodesTable).where(inArray(nodesTable.id, deleteIds));

  const remainingEdgeKeys = new Set(
    edges
      .filter((edge) => !deletedIds.has(edge.fromNodeId) && !deletedIds.has(edge.toNodeId))
      .map((edge) => `${edge.fromNodeId}:${edge.toNodeId}`)
  );

  for (const [key, edge] of additions) {
    if (!remainingEdgeKeys.has(key)) {
      await db.insert(nodeEdgesTable).values(edge);
      remainingEdgeKeys.add(key);
    }
  }
}

async function cleanupFuturePlanNodes(mapId: number, description: string): Promise<void> {
  if (!asksToCleanPlan(description)) return;

  const nodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, mapId));
  const nodeIds = nodes.map((node) => node.id);
  const edges = nodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
    : [];

  const futureNodes = nodes.filter((node) => node.status !== "completed");
  const completedNodes = nodes.filter((node) => node.status === "completed");
  const allowedRemaining = allowedRemainingOutcomes(description);
  const replacementByDeletedId = new Map<number, number | undefined>();
  const nodesToDelete = new Map<number, DbNode>();
  const futureByOutcome = new Map<OutcomeKey, DbNode[]>();

  for (const node of futureNodes) {
    const outcome = classifyOutcome(node);
    if (!outcome) continue;

    const completedReplacement = completedNodes.find((completed) => classifyOutcome(completed) === outcome);
    if (descriptionMarksOutcomeComplete(description, outcome)) {
      nodesToDelete.set(node.id, node);
      replacementByDeletedId.set(node.id, completedReplacement?.id);
      continue;
    }

    if (allowedRemaining && !allowedRemaining.has(outcome)) {
      nodesToDelete.set(node.id, node);
      replacementByDeletedId.set(node.id, completedReplacement?.id);
      continue;
    }

    const existing = futureByOutcome.get(outcome) ?? [];
    existing.push(node);
    futureByOutcome.set(outcome, existing);
  }

  for (const group of futureByOutcome.values()) {
    if (group.length <= 1) continue;
    const keeper = pickKeeper(group);
    for (const duplicate of group) {
      if (duplicate.id === keeper.id) continue;
      nodesToDelete.set(duplicate.id, duplicate);
      replacementByDeletedId.set(duplicate.id, keeper.id);
    }
  }

  await deleteFutureNodesAndRewire([...nodesToDelete.values()], replacementByDeletedId, edges);
}

async function unlockReadyNodes(mapId: number): Promise<void> {
  const nodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, mapId));
  const nodeIds = nodes.map((node) => node.id);
  if (nodeIds.length === 0) return;

  const edges = await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds));
  const completedIds = new Set(nodes.filter((node) => node.status === "completed").map((node) => node.id));
  const lockedNodes = nodes.filter((node) => node.status === "locked");

  for (const node of lockedNodes) {
    const prereqIds = edges
      .filter((edge) => edge.toNodeId === node.id)
      .map((edge) => edge.fromNodeId);
    if (prereqIds.length === 0 || prereqIds.every((id) => completedIds.has(id))) {
      await db.update(nodesTable)
        .set({ status: "available", updatedAt: new Date().toISOString() })
        .where(eq(nodesTable.id, node.id));
    }
  }
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

    // Clear code context so the next session starts fresh
    await tx.delete(projectCodeContextTable)
      .where(eq(projectCodeContextTable.projectId, params.data.projectId));

    const aiIdToDbId = new Map<string, number>();
    for (const aiNode of aiResult.nodes) {
      const isStarter = aiNode.prerequisite_ids.length === 0;
      const [insertedNode] = await tx.insert(nodesTable).values({
        mapId,
        title: aiNode.title,
        brief: aiNode.brief,
        status: isStarter ? "available" : "locked",
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

  const [profileForSummary] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));
  let summary = parsed.data.summary ?? null;

  if (parsed.data.status === "completed" && !summary) {
    try {
      const session = await getOrCreateChatSession(node.id);
      const history = (Array.isArray(session.messages) ? session.messages : []) as ChatMessage[];
      summary = await generateNodeSummary(node, project, history, profileForSummary ?? null);

      // Authoritative code extraction — runs on full chat history at completion time
      extractAndSaveFromMessages(params.data.projectId, node.title, project, history)
        .catch(() => {});
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
  const { files: codeFiles } = await getOrCreateCodeContext(params.data.projectId);

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
    for await (const chunk of streamOpeningMessage(node, project, profile ?? null, { allNodes, allEdges }, recentConcerns, codeFiles)) {
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

      // Extract code context from the opening message (fire-and-forget)
      extractAndSaveFromMessages(params.data.projectId, node.title, project, newMessages)
        .catch(() => {});
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
  const { files: codeFiles } = await getOrCreateCodeContext(params.data.projectId);

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
    const completedStepIndices = Array.isArray(req.body.completedStepIndices)
      ? (req.body.completedStepIndices as number[])
      : [];

    for await (const chunk of streamNodeChatMessage(
      node, project, profile ?? null, history, body.data.content, { allNodes, allEdges }, recentConcerns, codeFiles, completedStepIndices
    )) {
      fullContent += chunk;
      res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
    }

    // Parse [STEP_DONE:N] markers and emit step_done events before storing
    const stepDoneMatches = [...fullContent.matchAll(/\[STEP_DONE:(\d+)\]/g)];
    const newMessages: ChatMessage[] = [
      ...history,
      { role: "user" as const, content: body.data.content, createdAt: new Date().toISOString() },
      { role: "assistant" as const, content: fullContent, createdAt: new Date().toISOString() },
    ];

    await db.update(chatSessionsTable)
      .set({ messages: newMessages as any, updatedAt: new Date().toISOString() })
      .where(eq(chatSessionsTable.nodeId, node.id));

    for (const match of stepDoneMatches) {
      const stepIndex = parseInt(match[1], 10) - 1;
      res.write(`data: ${JSON.stringify({ type: "step_done", stepIndex })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);

    // Extract code context from the full updated messages (fire-and-forget)
    extractAndSaveFromMessages(params.data.projectId, node.title, project, newMessages)
      .catch(() => {});

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

        // Seed the extra node's chat with the explanation as its opening message
        await db.insert(chatSessionsTable).values({
          nodeId: newNode.id,
          messages: [{ role: "assistant", content: fullContent, createdAt: new Date().toISOString() }] as any,
        });

        // Replace main node's last assistant message with a redirect notification
        const redirectContent = `[EXTRA_REDIRECT:${JSON.stringify({ nodeId: newNode.id, title: spawned.title })}]`;
        const redirectMessages: ChatMessage[] = [
          ...history,
          { role: "user" as const, content: body.data.content, createdAt: new Date().toISOString() },
          { role: "assistant" as const, content: redirectContent, createdAt: new Date().toISOString() },
        ];
        await db.update(chatSessionsTable)
          .set({ messages: redirectMessages as any, updatedAt: new Date().toISOString() })
          .where(eq(chatSessionsTable.nodeId, node.id));

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

  await repositionCompletedIntegrationCheckpoints(map.id, body.data.description);
  await cleanupFuturePlanNodes(map.id, body.data.description);
  await unlockReadyNodes(map.id);

  const updatedNodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const updatedNodeIds = updatedNodes.map((n) => n.id);
  const updatedEdges = updatedNodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, updatedNodeIds))
    : [];

  res.json(RevisePlanResponse.parse({ projectId: params.data.projectId, nodes: updatedNodes, edges: updatedEdges }));
});

router.post("/projects/:projectId/nodes/:nodeId/visualize", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const projectId = parseInt(String(req.params.projectId ?? "0"), 10);
  const nodeId = parseInt(String(req.params.nodeId ?? "0"), 10);
  if (!projectId || !nodeId) { res.status(400).json({ error: "Invalid params" }); return; }

  const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
  if (!topic) { res.status(400).json({ error: "topic is required" }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const [node] = await db.select().from(nodesTable)
    .where(and(eq(nodesTable.id, nodeId), eq(nodesTable.mapId, map.id)));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  try {
    for await (const chunk of streamVisualization(topic, node.title, profile ?? null)) {
      res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err?.message ?? "Stream error" })}\n\n`);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
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

  await unlockReadyNodes(map.id);

  const nodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const nodeIds = nodes.map((n) => n.id);
  const edges = nodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
    : [];

  res.json({ projectId, nodes, edges });
});

export default router;
