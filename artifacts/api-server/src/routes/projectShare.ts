import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { db, projectsTable, nodeMapsTable, nodesTable, nodeEdgesTable } from "@workspace/db";
import { requireAuth, getAuthUserId } from "../lib/auth";

const router: IRouter = Router();

// A ".pforge" file is a SNAPSHOT of a project's plan: the project header + the
// node map (titles, briefs, per-node agent notes, dependencies) with stable
// STRING ids — no DB ids, no owner, no chat, no learner profile. Per-step content
// is regenerated for whoever imports it (personalized to their level), which is
// also the "regenerate it yourself" escape hatch.
const SNAPSHOT_FORMAT = "pathforge.project.snapshot";

function safeFileName(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}

router.get("/projects/:projectId/export", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.clerkUserId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [map] = await db.select().from(nodeMapsTable).where(eq(nodeMapsTable.projectId, projectId));
  if (!map) { res.status(404).json({ error: "This project has no node map to export yet" }); return; }

  const nodes = await db.select().from(nodesTable).where(eq(nodesTable.mapId, map.id)).orderBy(nodesTable.createdAt);
  const nodeIds = nodes.map((n) => n.id);
  const edges = nodeIds.length > 0
    ? await db.select().from(nodeEdgesTable).where(inArray(nodeEdgesTable.fromNodeId, nodeIds))
    : [];

  // Stable, portable string ids so the file carries no DB internals.
  const idToStr = new Map(nodes.map((n, i) => [n.id, `n${i + 1}`]));
  const exportNodes = nodes.map((n) => ({
    id: idToStr.get(n.id)!,
    title: n.title,
    brief: n.brief,
    agent_context: n.agentContext,
    is_extra: n.isExtra,
    prerequisite_ids: edges
      .filter((e) => e.toNodeId === n.id)
      .map((e) => idToStr.get(e.fromNodeId))
      .filter((v): v is string => Boolean(v)),
  }));

  const snapshot = {
    format: SNAPSHOT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    project: { title: project.title, ideaPrompt: project.ideaPrompt },
    map: { nodes: exportNodes },
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFileName(project.title)}.pforge"`);
  res.json(snapshot);
});

// Imported files are UNTRUSTED (authored by someone else). Validate strictly and
// bound every size — node text later flows into tutor prompts, so it must be
// treated as data, never instructions.
const ImportSchema = z.object({
  format: z.literal(SNAPSHOT_FORMAT),
  version: z.literal(1),
  project: z.object({
    title: z.string().min(1).max(200),
    ideaPrompt: z.string().min(1).max(4000),
  }),
  map: z.object({
    nodes: z.array(z.object({
      id: z.string().min(1).max(60),
      title: z.string().min(1).max(200),
      brief: z.string().max(2000).nullish(),
      agent_context: z.string().max(8000).nullish(),
      is_extra: z.boolean().optional(),
      prerequisite_ids: z.array(z.string().min(1).max(60)).max(50).optional(),
    })).min(1).max(100),
  }),
});

router.post("/projects/import", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const parsed = ImportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `Not a valid .pforge file: ${parsed.error.message}` });
    return;
  }
  const { project: projectInput, map } = parsed.data;

  // Dedup ids defensively; ignore prereqs that don't resolve within the file.
  const seen = new Set<string>();
  for (const node of map.nodes) {
    if (seen.has(node.id)) { res.status(400).json({ error: `Duplicate node id: ${node.id}` }); return; }
    seen.add(node.id);
  }

  const newProject = await db.transaction(async (tx) => {
    const [project] = await tx.insert(projectsTable).values({
      clerkUserId: userId,
      title: projectInput.title,
      ideaPrompt: projectInput.ideaPrompt,
      status: "active",
    }).returning();

    const [newMap] = await tx.insert(nodeMapsTable)
      .values({ projectId: project.id, rawJson: JSON.stringify(map) })
      .returning();

    const strToDbId = new Map<string, number>();
    for (const node of map.nodes) {
      const isStarter = !node.prerequisite_ids || node.prerequisite_ids.length === 0;
      const [inserted] = await tx.insert(nodesTable).values({
        mapId: newMap.id,
        title: node.title,
        brief: node.brief ?? "",
        status: isStarter ? "available" : "locked",
        isExtra: node.is_extra ?? false,
        agentContext: node.agent_context?.trim() || null,
      }).returning();
      strToDbId.set(node.id, inserted.id);
    }

    for (const node of map.nodes) {
      const toNodeId = strToDbId.get(node.id);
      if (!toNodeId) continue;
      for (const prereq of node.prerequisite_ids ?? []) {
        const fromNodeId = strToDbId.get(prereq);
        if (!fromNodeId) continue; // ignore dangling references
        await tx.insert(nodeEdgesTable).values({ fromNodeId, toNodeId });
      }
    }

    return project;
  });

  res.status(201).json({ projectId: newProject.id, title: newProject.title });
});

export default router;
