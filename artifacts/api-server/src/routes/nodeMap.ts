import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, projectsTable, nodeMapsTable, nodesTable, nodeEdgesTable, chatSessionsTable, learnerProfilesTable, projectCodeContextTable } from "@workspace/db";
import type { CodeFile, Node as DbNode, NodeEdge } from "@workspace/db";

// A `db.transaction()` callback's `tx` param — accepted alongside `db` by helpers below
// so a caller can run a group of writes atomically instead of as separate statements.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbClient = typeof db | Tx;
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
  GetNodeStepDetailParams,
  GetNodeStepDetailBody,
  GetNodeVisualizationParams,
  GetNodeVisualizationBody,
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
  streamStepDetail,
  classifyExtraNodeNeeded,
  generateNodeSummary,
  generateSpawnedNode,
  generateStepUpdate,
  revisePlanNodes,
  extractCodeContextUpdates,
  applyCodeContextUpdates,
  extractSessionFacts,
  type ChatMessage,
  type ChatToolCall,
} from "../lib/aiNodeChat";

async function getOrCreateCodeContext(projectId: number): Promise<{ id: number; files: CodeFile[] }> {
  const [existing] = await db.select().from(projectCodeContextTable).where(eq(projectCodeContextTable.projectId, projectId));
  if (existing) return { id: existing.id, files: (existing.files as CodeFile[]) ?? [] };
  // Race-safe: a concurrent request may insert between our SELECT and INSERT.
  const [created] = await db.insert(projectCodeContextTable)
    .values({ projectId, files: [] as any })
    .onConflictDoNothing({ target: projectCodeContextTable.projectId })
    .returning();
  if (created) return { id: created.id, files: [] };
  const [afterRace] = await db.select().from(projectCodeContextTable).where(eq(projectCodeContextTable.projectId, projectId));
  return { id: afterRace.id, files: (afterRace.files as CodeFile[]) ?? [] };
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
  // Race-safe: a concurrent request (e.g. two open tabs) may insert between our SELECT and INSERT.
  const [created] = await db.insert(chatSessionsTable)
    .values({ nodeId, messages: [] })
    .onConflictDoNothing({ target: chatSessionsTable.nodeId })
    .returning();
  if (created) return created;
  const [afterRace] = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.nodeId, nodeId));
  return afterRace;
}

/**
 * Atomically read-modify-write a node's chat messages under a row lock, so concurrent
 * requests (two tabs, or a chat message racing a step-detail save) can't clobber each
 * other's writes with a stale snapshot.
 */
async function updateChatSession(
  nodeId: number,
  updater: (current: ChatMessage[]) => ChatMessage[]
): Promise<ChatMessage[]> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(chatSessionsTable).where(eq(chatSessionsTable.nodeId, nodeId)).for("update");
    const current = (Array.isArray(session?.messages) ? session.messages : []) as ChatMessage[];
    const updated = updater(current);
    if (session) {
      await tx.update(chatSessionsTable)
        .set({ messages: updated as any, updatedAt: new Date().toISOString() })
        .where(eq(chatSessionsTable.nodeId, nodeId));
    } else {
      await tx.insert(chatSessionsTable).values({ nodeId, messages: updated as any });
    }
    return updated;
  });
}

// The model can call tools with no accompanying text (confirmed against the live API —
// finish_reason "tool_calls" with empty content is a real, not just hypothetical, case)
// despite the prompt asking for a reply. Rather than persist a blank assistant turn that
// looks like nothing happened, synthesize a short note from the actions taken.
function synthesizeActionSummary(toolCalls: ChatToolCall[]): string {
  const parts: string[] = [];
  for (const tc of toolCalls) {
    switch (tc.name) {
      case "update_step":
        if (typeof tc.args.stepNumber === "number") {
          const introToo = typeof tc.args.introUpdate === "string" && tc.args.introUpdate.trim();
          parts.push(`Updated step ${tc.args.stepNumber}${introToo ? " and the session overview" : ""}.`);
        }
        break;
      case "add_steps":
        parts.push("Added new steps to the session.");
        break;
      case "regenerate_session":
        parts.push("Rebuilt the session plan.");
        break;
      case "spawn_node":
        if (typeof tc.args.title === "string") parts.push(`Created a new node: "${tc.args.title}".`);
        break;
      case "mark_steps_done":
        parts.push("Marked step(s) complete.");
        break;
    }
  }
  return parts.join(" ");
}

interface OpeningSlide { key: string; body: string }

// The opening message (first real assistant message in a chat session) encodes the
// session plan as `[SLIDE:intro]...[SLIDE:1]...[SLIDE:2]...`. These helpers parse/
// reserialize that format so step-update/intro-update/steps-add edits from the AI can be
// applied to the one persisted copy instead of only living in the current stream.
function parseOpeningSlides(content: string): OpeningSlide[] {
  const slides: OpeningSlide[] = [];
  const parts = content.split(/\[SLIDE:(\w+)\]/);
  for (let i = 1; i < parts.length - 1; i += 2) {
    const key = parts[i].trim();
    const body = parts[i + 1].trim();
    if (body) slides.push({ key, body });
  }
  return slides;
}

function serializeOpeningSlides(slides: OpeningSlide[]): string {
  return slides.map(({ key, body }) => `[SLIDE:${key}]\n${body}`).join("\n\n");
}

// Step slide bodies are always `**Title**\n<brief>` (see streamOpeningMessage's format
// instructions and applyPlanEdits' own writes) — extracts the two parts back out for use
// as context when generating a step update.
function parseStepSlideBody(body: string): { title: string; brief: string } {
  const match = /^\*\*(.+?)\*\*\s*\n+([\s\S]*)$/.exec(body.trim());
  if (!match) return { title: "", brief: body.trim() };
  return { title: match[1].trim(), brief: match[2].trim() };
}

/**
 * Applies update_step / add_steps tool calls onto a node's persisted opening message.
 * Returns the new opening content plus which step numbers had their content replaced
 * (their generated detail page is now stale and must regenerate). update_step's optional
 * introUpdate rewrites the intro slide's own body alongside the step — there is no
 * standalone way to edit only the intro. Broader plan changes that plausibly touch many
 * steps at once go through a full regeneration instead — see regenerate_session.
 */
function applyPlanEdits(
  openingContent: string,
  stepUpdates: Map<number, string>,
  newSteps: Array<{ title: string; brief: string }>,
  introUpdate?: string | null
): { content: string; invalidatedStepNumbers: number[] } {
  const slides = parseOpeningSlides(openingContent);
  const invalidatedStepNumbers: number[] = [];

  for (const slide of slides) {
    if (slide.key === "intro") {
      if (introUpdate) slide.body = introUpdate;
      continue;
    }
    const n = parseInt(slide.key, 10);
    if (!isNaN(n) && stepUpdates.has(n)) {
      slide.body = stepUpdates.get(n)!;
      invalidatedStepNumbers.push(n);
    }
  }

  if (newSteps.length > 0) {
    const existingStepNumbers = slides.map((s) => parseInt(s.key, 10)).filter((n) => !isNaN(n));
    let nextStepNumber = existingStepNumbers.length > 0 ? Math.max(...existingStepNumbers) + 1 : 1;
    for (const step of newSteps) {
      slides.push({ key: String(nextStepNumber), body: `**${step.title}**\n${step.brief}` });
      nextStepNumber++;
    }
  }

  return {
    content: serializeOpeningSlides(slides),
    invalidatedStepNumbers,
  };
}

async function getRecentConcerns(excludeNodeId: number, mapId: number): Promise<string[]> {
  const otherNodes = await db
    .select()
    .from(nodesTable)
    .where(and(eq(nodesTable.mapId, mapId), eq(nodesTable.status, "completed")))
    .orderBy(nodesTable.updatedAt)
    .limit(5);

  const nodeIds = otherNodes.filter((n) => n.id !== excludeNodeId).map((n) => n.id);
  if (nodeIds.length === 0) return [];

  const sessions = await db.select().from(chatSessionsTable).where(inArray(chatSessionsTable.nodeId, nodeIds));
  const sessionsByNodeId = new Map(sessions.map((s) => [s.nodeId, s]));

  const concerns: string[] = [];
  for (const n of otherNodes) {
    if (n.id === excludeNodeId) continue;
    const session = sessionsByNodeId.get(n.id);
    if (!session) continue;
    const msgs = (Array.isArray(session.messages) ? session.messages : []) as ChatMessage[];
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

async function repositionCompletedIntegrationCheckpoints(dbClient: DbClient, mapId: number, description: string): Promise<void> {
  if (!asksToRepositionCheckpoint(description)) return;

  const nodes = await dbClient.select().from(nodesTable).where(eq(nodesTable.mapId, mapId));
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
    await dbClient.delete(nodeEdgesTable).where(eq(nodeEdgesTable.fromNodeId, checkpoint.id));
    await dbClient.delete(nodeEdgesTable).where(eq(nodeEdgesTable.toNodeId, checkpoint.id));

    for (const upstream of upstreamNodes) {
      await dbClient.insert(nodeEdgesTable).values({
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
  dbClient: DbClient,
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
  // node_edges.{from,to}_node_id cascade from nodes.id, so deleting the nodes alone would
  // suffice — the explicit edge deletes stay for clarity and to work even if cascade is
  // ever removed from the schema.
  await dbClient.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.toNodeId, deleteIds));
  await dbClient.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, deleteIds));
  await dbClient.delete(nodesTable).where(inArray(nodesTable.id, deleteIds));

  const remainingEdgeKeys = new Set(
    edges
      .filter((edge) => !deletedIds.has(edge.fromNodeId) && !deletedIds.has(edge.toNodeId))
      .map((edge) => `${edge.fromNodeId}:${edge.toNodeId}`)
  );

  for (const [key, edge] of additions) {
    if (!remainingEdgeKeys.has(key)) {
      await dbClient.insert(nodeEdgesTable).values(edge);
      remainingEdgeKeys.add(key);
    }
  }
}

async function cleanupFuturePlanNodes(dbClient: DbClient, mapId: number, description: string): Promise<void> {
  if (!asksToCleanPlan(description)) return;

  const nodes = await dbClient.select().from(nodesTable).where(eq(nodesTable.mapId, mapId));
  const nodeIds = nodes.map((node) => node.id);
  const edges = nodeIds.length > 0
    ? await dbClient.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
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

  await deleteFutureNodesAndRewire(dbClient, [...nodesToDelete.values()], replacementByDeletedId, edges);
}

async function unlockReadyNodes(dbClient: DbClient, mapId: number): Promise<void> {
  const nodes = await dbClient.select().from(nodesTable).where(eq(nodesTable.mapId, mapId));
  const nodeIds = nodes.map((node) => node.id);
  if (nodeIds.length === 0) return;

  const edges = await dbClient.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds));
  const completedIds = new Set(nodes.filter((node) => node.status === "completed").map((node) => node.id));
  const lockedNodes = nodes.filter((node) => node.status === "locked");

  const readyToUnlockIds = lockedNodes
    .filter((node) => {
      const prereqIds = edges.filter((edge) => edge.toNodeId === node.id).map((edge) => edge.fromNodeId);
      return prereqIds.length === 0 || prereqIds.every((id) => completedIds.has(id));
    })
    .map((node) => node.id);

  if (readyToUnlockIds.length === 0) return;
  await dbClient.update(nodesTable)
    .set({ status: "available", updatedAt: new Date().toISOString() })
    .where(inArray(nodesTable.id, readyToUnlockIds));
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
        .catch((err) => req.log.error({ err }, "code context extraction failed on node completion"));
    } catch (err) {
      req.log.error({ err }, "node summary generation failed");
      summary = `Completed ${node.title}`;
    }
  }

  // Status update, dependent-unlock, and project-completion must apply together —
  // a failure partway through would otherwise leave dependents locked despite their
  // prerequisite showing "completed".
  await db.transaction(async (tx) => {
    await tx.update(nodesTable)
      .set({ status: parsed.data.status, summary })
      .where(eq(nodesTable.id, params.data.nodeId));

    if (parsed.data.status === "completed") {
      const allNodes = await tx.select().from(nodesTable).where(eq(nodesTable.mapId, map.id));
      const allEdges = await tx.select().from(nodeEdgesTable).where(
        inArray(nodeEdgesTable.fromNodeId, allNodes.map((n) => n.id))
      );

      const completedIds = new Set(
        allNodes.filter((n) => n.id === params.data.nodeId ? true : n.status === "completed").map((n) => n.id)
      );

      const readyToUnlockIds = allNodes
        .filter((n) => {
          if (n.status !== "locked") return false;
          const prereqs = allEdges.filter((e) => e.toNodeId === n.id).map((e) => e.fromNodeId);
          return prereqs.length > 0 && prereqs.every((pid) => completedIds.has(pid));
        })
        .map((n) => n.id);

      if (readyToUnlockIds.length > 0) {
        await tx.update(nodesTable).set({ status: "available" }).where(inArray(nodesTable.id, readyToUnlockIds));
      }

      const allCompleted = allNodes.every((n) =>
        n.id === params.data.nodeId ? true : n.status === "completed"
      );
      if (allCompleted) {
        await tx.update(projectsTable).set({ status: "completed" }).where(eq(projectsTable.id, params.data.projectId));
      }
    }
  });

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
  const rawMessages = Array.isArray(session.messages) ? session.messages : [];
  // Filter to only valid roles so Zod parse never throws on stale/legacy data
  const messages = (rawMessages as Array<Record<string, unknown>>).filter(
    (m) => m.role === "user" || m.role === "assistant"
  );

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

    // Save only if no intro exists yet (step_detail messages don't count). The row lock
    // inside updateChatSession makes this check-then-write atomic against concurrent
    // requests (e.g. two tabs opening the same node at once).
    let introMessage: ChatMessage | null = null;
    await updateChatSession(node.id, (current) => {
      const hasIntro = current.some(
        (m) => m.role === "assistant" && !m.content.startsWith("[STEP_DETAIL:")
      );
      if (hasIntro) return current;
      introMessage = {
        role: "assistant",
        content: fullContent,
        createdAt: new Date().toISOString(),
      };
      return [introMessage, ...current];
    });

    if (introMessage) {
      // Extract code context from the opening message (fire-and-forget)
      extractAndSaveFromMessages(params.data.projectId, node.title, project, [introMessage])
        .catch((err) => req.log.error({ err }, "code context extraction failed on opening message"));
    }

    res.write("data: [DONE]\n\n");
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err?.message ?? "Stream error" })}\n\n`);
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

    const chatGen = streamNodeChatMessage(
      node, project, profile ?? null, history, body.data.content, { allNodes, allEdges }, recentConcerns, codeFiles, completedStepIndices
    );
    let toolCalls: ChatToolCall[] = [];
    let step = await chatGen.next();
    while (!step.done) {
      fullContent += step.value;
      res.write(`data: ${JSON.stringify({ type: "chunk", content: step.value })}\n\n`);
      step = await chatGen.next();
    }
    toolCalls = step.value;

    const displayContent = fullContent.trim() || synthesizeActionSummary(toolCalls);
    const userMsg: ChatMessage = { role: "user", content: body.data.content, createdAt: new Date().toISOString() };
    const assistantMsg: ChatMessage = { role: "assistant", content: displayContent, createdAt: new Date().toISOString() };

    // Append onto the freshest row state under a lock (not the possibly-stale `history`
    // read before the AI stream started), so a concurrent write from another tab/request
    // during the stream can't be clobbered.
    const newMessages = await updateChatSession(node.id, (current) => [...current, userMsg, assistantMsg]);

    const markDoneCall = toolCalls.find((tc) => tc.name === "mark_steps_done");
    if (markDoneCall) {
      const stepNumbers = Array.isArray(markDoneCall.args.stepNumbers) ? markDoneCall.args.stepNumbers : [];
      for (const n of stepNumbers) {
        if (typeof n === "number" && Number.isFinite(n)) {
          res.write(`data: ${JSON.stringify({ type: "step_done", stepIndex: n - 1 })}\n\n`);
        }
      }
    }

    const regenerateCall = toolCalls.find((tc) => tc.name === "regenerate_session");

    if (regenerateCall) {
      // A foundational assumption changed (environment, naming, architecture) — rebuild
      // the entire plan (intro + every step) in one dedicated pass, instead of
      // hand-patching just the intro text and leaving steps silently referencing
      // outdated facts. The conversation is distilled into a short fact list first
      // (rather than dumping the raw transcript into the prompt) so the regeneration
      // stays consistent with corrections made earlier without the transcript's bulk
      // crowding out per-step variety in the output.
      try {
        const reason = typeof regenerateCall.args.reason === "string" ? regenerateCall.args.reason : "the plan needed a broad update";
        const facts = await extractSessionFacts(newMessages).catch((err) => {
          req.log.warn({ err }, "session-facts extraction failed, regenerating without them");
          return [];
        });

        let regeneratedContent = "";
        for await (const chunk of streamOpeningMessage(
          node, project, profile ?? null, { allNodes, allEdges }, recentConcerns, codeFiles,
          { reason, facts }
        )) {
          regeneratedContent += chunk;
        }

        if (regeneratedContent) {
          const updatedMessages = await updateChatSession(node.id, (current) => {
            const openingIdx = current.findIndex((m) => m.role === "assistant" && m.content.includes("[SLIDE:"));
            const next = openingIdx === -1
              ? [{ role: "assistant" as const, content: regeneratedContent, createdAt: new Date().toISOString() }, ...current]
              : current.map((m, i) => (i === openingIdx ? { ...m, content: regeneratedContent } : m));

            // Full regeneration invalidates every step's cached detail page.
            return next.filter((m) => !(m.role === "assistant" && /^\[STEP_DETAIL:\d+\]/.test(m.content)));
          });

          const openingMsg = updatedMessages.find((m) => m.role === "assistant" && m.content.includes("[SLIDE:"));
          if (openingMsg) {
            res.write(`data: ${JSON.stringify({ type: "plan_updated", openingContent: openingMsg.content })}\n\n`);
          }
        }
      } catch (err) {
        req.log.error({ err }, "session regeneration failed");
        res.write(`data: ${JSON.stringify({ type: "plan_update_failed" })}\n\n`);
      }
    } else {
      // Apply any update_step / add_steps calls to the persisted session plan (the
      // opening message), and purge cached step-detail pages that are now stale so they
      // regenerate the next time the learner opens them. There's no standalone
      // intro-editing tool — an intro fix only ever rides along inside an update_step
      // call (its optional introUpdate field), never alone.
      //
      // Two-phase content generation: the chat model only flags stepNumber + reason (it
      // does not author the new title/description itself). Phase 1 below runs a
      // dedicated generateStepUpdate() call per flagged step, using the step's current
      // content + sibling steps + the reason as context, so the rewrite stays consistent
      // with the rest of the plan instead of depending on whatever else was in this chat
      // turn. Phase 2 (streamStepDetail, on next open) then regenerates the step's detail
      // page from ONLY that new title/brief.
      const stepUpdates = new Map<number, string>();
      let introUpdate: string | null = null;

      const updateStepCalls = toolCalls.filter(
        (tc): tc is ChatToolCall & { args: { stepNumber: number; reason: string } } =>
          tc.name === "update_step" && typeof tc.args.stepNumber === "number" && typeof tc.args.reason === "string"
      );

      if (updateStepCalls.length > 0) {
        const openingMsgForRead = newMessages.find((m) => m.role === "assistant" && m.content.includes("[SLIDE:"));
        const currentSlides = openingMsgForRead ? parseOpeningSlides(openingMsgForRead.content) : [];
        const stepSlideByNumber = new Map(
          currentSlides
            .filter((s) => s.key !== "intro")
            .map((s) => [parseInt(s.key, 10), parseStepSlideBody(s.body)] as const)
        );

        const results = await Promise.allSettled(
          updateStepCalls.map(async (tc) => {
            const { stepNumber, reason } = tc.args;
            const currentStep = stepSlideByNumber.get(stepNumber);
            if (!currentStep) throw new Error(`Step ${stepNumber} not found in current plan`);

            const siblingSteps = [...stepSlideByNumber.entries()]
              .filter(([n]) => n !== stepNumber)
              .map(([, s]) => s);

            const result = await generateStepUpdate(node, project, reason, currentStep, siblingSteps);
            return { stepNumber, result };
          })
        );

        for (const r of results) {
          if (r.status === "fulfilled") {
            stepUpdates.set(r.value.stepNumber, `**${r.value.result.title}**\n${r.value.result.brief}`);
          } else {
            req.log.error({ err: r.reason }, "step update generation failed for one step");
          }
        }
      }

      for (const tc of toolCalls) {
        if (tc.name !== "update_step") continue;
        if (typeof tc.args.introUpdate === "string" && tc.args.introUpdate.trim()) {
          introUpdate = tc.args.introUpdate.trim();
        }
      }

      const newSteps: Array<{ title: string; brief: string }> = [];
      const addStepsCall = toolCalls.find((tc) => tc.name === "add_steps");
      if (addStepsCall && Array.isArray(addStepsCall.args.steps)) {
        for (const s of addStepsCall.args.steps) {
          if (s && typeof s.title === "string" && typeof s.description === "string") {
            newSteps.push({ title: s.title, brief: s.description });
          }
        }
      }

      if (stepUpdates.size > 0 || newSteps.length > 0 || introUpdate) {
        const updatedMessages = await updateChatSession(node.id, (current) => {
          const openingIdx = current.findIndex((m) => m.role === "assistant" && m.content.includes("[SLIDE:"));
          if (openingIdx === -1) return current;

          const { content, invalidatedStepNumbers } = applyPlanEdits(current[openingIdx].content, stepUpdates, newSteps, introUpdate);
          const next = [...current];
          next[openingIdx] = { ...next[openingIdx], content };

          // Purge stale per-step detail pages so they regenerate on next open.
          return next.filter((m) => {
            if (m.role !== "assistant") return true;
            const detailMatch = /^\[STEP_DETAIL:(\d+)\]/.exec(m.content);
            if (!detailMatch) return true;
            return !invalidatedStepNumbers.includes(parseInt(detailMatch[1], 10));
          });
        });

        // Send the canonical updated plan; the frontend diffs it against its current
        // slides to figure out which step(s) actually changed and need regeneration.
        const openingMsg = updatedMessages.find((m) => m.role === "assistant" && m.content.includes("[SLIDE:"));
        if (openingMsg) {
          res.write(`data: ${JSON.stringify({ type: "plan_updated", openingContent: openingMsg.content })}\n\n`);
        }
      }
    }

    // Carry the resolved display content (which may be the synthesized action summary,
    // not the raw streamed text — the model often calls tools with no accompanying reply
    // text at all). Without this, the frontend has no way to know a fallback was used and
    // would show nothing, even though the DB has the real notification.
    res.write(`data: ${JSON.stringify({ type: "done", content: displayContent })}\n\n`);

    // Extract code context from the full updated messages (fire-and-forget)
    extractAndSaveFromMessages(params.data.projectId, node.title, project, newMessages)
      .catch((err) => req.log.error({ err }, "code context extraction failed on chat message"));

    for (const tc of toolCalls) {
      if (tc.name !== "spawn_node") continue;
      const title = typeof tc.args.title === "string" ? tc.args.title.trim() : "";
      const brief = typeof tc.args.brief === "string" ? tc.args.brief.trim() : "";
      if (!title || !brief) continue;

      try {
        // Node creation + edge wiring must succeed together — an orphaned unreachable
        // node is worse than failing the whole spawn. No opening message is pre-seeded:
        // the node lazily generates a real, AI-sized opening session (adaptive step
        // count) on first visit, exactly like any other node.
        const newNode = await db.transaction(async (tx) => {
          const [inserted] = await tx.insert(nodesTable).values({
            mapId: map.id,
            title,
            brief,
            status: "available",
            isExtra: true,
          }).returning();
          await tx.insert(nodeEdgesTable).values({ fromNodeId: node.id, toNodeId: inserted.id });
          return inserted;
        });

        // Record redirect in current node's chat history — appends onto the freshest
        // state under a lock so multiple spawn calls in one response (and any
        // concurrent request) each keep their own redirect instead of overwriting.
        const redirectContent = `[EXTRA_REDIRECT:${JSON.stringify({ nodeId: newNode.id, title })}]`;
        const redirectMsg: ChatMessage = { role: "assistant", content: redirectContent, createdAt: new Date().toISOString() };
        await updateChatSession(node.id, (current) => [...current, redirectMsg]);

        res.write(`data: ${JSON.stringify({ type: "extra_node_spawned", nodeId: newNode.id, title })}\n\n`);
      } catch (err) {
        req.log.warn({ err, title }, "spawn_node tool call failed — skipped");
      }
    }
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err?.message ?? "Stream error" })}\n\n`);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

router.post("/projects/:projectId/nodes/:nodeId/step-detail", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetNodeStepDetailParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const body = GetNodeStepDetailBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const { stepIndex, stepTitle, stepBrief } = body.data;

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const [node] = await db.select().from(nodesTable)
    .where(and(eq(nodesTable.id, params.data.nodeId), eq(nodesTable.mapId, map.id)));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  const [profile] = await db.select().from(learnerProfilesTable).where(eq(learnerProfilesTable.clerkUserId, userId));
  const { files: codeFiles } = await getOrCreateCodeContext(params.data.projectId);
  const mapCtx = await getMapContext(map.id);

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
    const stream = streamStepDetail(
      node, project, profile ?? null, mapCtx, codeFiles,
      stepIndex, stepTitle, stepBrief ?? ""
    );
    for await (const chunk of stream) {
      fullContent += chunk;
      res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);

    // Persist to DB so subsequent opens don't regenerate.
    // Encoded as a regular "assistant" message with a STEP_DETAIL marker so
    // it passes the Zod schema (role must be 'user' | 'assistant').
    if (fullContent) {
      const marker = `[STEP_DETAIL:${stepIndex}]`;
      await updateChatSession(params.data.nodeId, (current) => {
        // Strip any prior entry for this step (old role=step_detail format OR new marker format)
        const filtered = (current as unknown as Array<Record<string, unknown>>).filter(
          (m) => !(m.role === "step_detail" && m.stepIndex === stepIndex) && !((m.content as string | undefined)?.startsWith(marker))
        ) as unknown as ChatMessage[];
        return [
          ...filtered,
          {
            role: "assistant",
            content: `${marker}\n${fullContent}\n[/STEP_DETAIL:${stepIndex}]`,
            createdAt: new Date().toISOString(),
          },
        ];
      });
    }
  } catch (err: any) {
    req.log.error({ err }, "step-detail stream error");
    res.write(`data: ${JSON.stringify({ type: "error", error: err?.message ?? "Unknown error" })}\n\n`);
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

  // Node creation + edge wiring must succeed together — an orphaned unreachable
  // node is worse than failing the whole request.
  await db.transaction(async (tx) => {
    const [newNode] = await tx.insert(nodesTable).values({
      mapId: map.id,
      title: spawnedNode.title,
      brief: spawnedNode.brief,
      status: "available",
      isExtra: true,
    }).returning();
    await tx.insert(nodeEdgesTable).values({ fromNodeId: parentNode.id, toNodeId: newNode.id });
  });

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

  // The whole revision — deleting dropped nodes, updating/inserting revised ones,
  // rewiring edges, and the cleanup passes — must apply as one unit. A failure partway
  // through (bad AI-generated id, constraint violation) would otherwise leave the DAG
  // half-revised: some nodes deleted, edges missing, orphaned or duplicate nodes.
  await db.transaction(async (tx) => {
    const unmentionedFuture = futureNodes.filter((n) => !mentionedExistingIds.has(n.id));
    if (unmentionedFuture.length > 0) {
      const unmentionedIds = unmentionedFuture.map((n) => n.id);
      await tx.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.toNodeId, unmentionedIds));
      await tx.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, unmentionedIds));
      await tx.delete(nodesTable).where(inArray(nodesTable.id, unmentionedIds));
    }

    const newIdMap = new Map<string, number>();

    for (const r of aiResult.revised_nodes) {
      const existMatch = r.id.match(existingIdPattern);
      if (existMatch) {
        const dbId = parseInt(existMatch[1], 10);
        const existing = futureNodes.find((n) => n.id === dbId);
        if (existing) {
          await tx.update(nodesTable)
            .set({ title: r.title, brief: r.brief, updatedAt: new Date().toISOString() })
            .where(eq(nodesTable.id, dbId));
          newIdMap.set(r.id, dbId);
        }
      } else {
        const [inserted] = await tx.insert(nodesTable).values({
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
      await tx.delete(nodeEdgesTable).where(inArray(nodeEdgesTable.toNodeId, affectedNodeIds));
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
          await tx.insert(nodeEdgesTable).values({ fromNodeId: fromId, toNodeId: toId });
        }
      }
    }

    await repositionCompletedIntegrationCheckpoints(tx, map.id, body.data.description);
    await cleanupFuturePlanNodes(tx, map.id, body.data.description);
    await unlockReadyNodes(tx, map.id);
  });

  const updatedNodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const updatedNodeIds = updatedNodes.map((n) => n.id);
  const updatedEdges = updatedNodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, updatedNodeIds))
    : [];

  res.json(RevisePlanResponse.parse({ projectId: params.data.projectId, nodes: updatedNodes, edges: updatedEdges }));
});

router.post("/projects/:projectId/nodes/:nodeId/visualize", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetNodeVisualizationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const body = GetNodeVisualizationBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const topic = body.data.topic.trim();

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, params.data.projectId));
  if (!map) { res.status(404).json({ error: "Node map not found" }); return; }

  const [node] = await db.select().from(nodesTable)
    .where(and(eq(nodesTable.id, params.data.nodeId), eq(nodesTable.mapId, map.id)));
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

  await unlockReadyNodes(db, map.id);

  const nodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const nodeIds = nodes.map((n) => n.id);
  const edges = nodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
    : [];

  res.json({ projectId, nodes, edges });
});

export default router;
