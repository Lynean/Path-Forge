import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, projectsTable, projectWorkspacesTable } from "@workspace/db";
import {
  GetProjectWorkspaceParams,
  GetProjectWorkspaceResponse,
  SetProjectWorkspaceParams,
  SetProjectWorkspaceBody,
  SetProjectWorkspaceResponse,
} from "@workspace/api-zod";
import { requireAuth, getAuthUserId } from "../lib/auth";

const router: IRouter = Router();

async function userOwnsProject(userId: string, projectId: number): Promise<boolean> {
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.clerkUserId, userId)));
  return Boolean(project);
}

router.get("/projects/:projectId/workspace", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetProjectWorkspaceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await userOwnsProject(userId, params.data.projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [workspace] = await db
    .select()
    .from(projectWorkspacesTable)
    .where(eq(projectWorkspacesTable.projectId, params.data.projectId));
  if (!workspace) {
    res.status(404).json({ error: "No workspace attached" });
    return;
  }
  res.json(GetProjectWorkspaceResponse.parse(workspace));
});

router.put("/projects/:projectId/workspace", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = SetProjectWorkspaceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SetProjectWorkspaceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!(await userOwnsProject(userId, params.data.projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [workspace] = await db
    .insert(projectWorkspacesTable)
    .values({ projectId: params.data.projectId, path: body.data.path })
    .onConflictDoUpdate({
      target: projectWorkspacesTable.projectId,
      set: { path: body.data.path },
    })
    .returning();
  res.json(SetProjectWorkspaceResponse.parse(workspace));
});

export default router;
