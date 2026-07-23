import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, projectsTable, projectEnvironmentsTable } from "@workspace/db";
import {
  GetProjectEnvironmentParams,
  GetProjectEnvironmentResponse,
  SetProjectEnvironmentParams,
  SetProjectEnvironmentBody,
  SetProjectEnvironmentResponse,
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

router.get("/projects/:projectId/environment", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetProjectEnvironmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await userOwnsProject(userId, params.data.projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const [env] = await db
    .select()
    .from(projectEnvironmentsTable)
    .where(eq(projectEnvironmentsTable.projectId, params.data.projectId));
  if (!env) {
    res.status(404).json({ error: "No environment approved" });
    return;
  }
  res.json(GetProjectEnvironmentResponse.parse(env));
});

router.put("/projects/:projectId/environment", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = SetProjectEnvironmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SetProjectEnvironmentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!(await userOwnsProject(userId, params.data.projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const values = {
    projectId: params.data.projectId,
    language: body.data.language ?? null,
    baseImage: body.data.baseImage,
    setupCommands: body.data.setupCommands ?? [],
    runCommand: body.data.runCommand,
    dockerfile: body.data.dockerfile ?? null,
  };
  const [env] = await db
    .insert(projectEnvironmentsTable)
    .values(values)
    .onConflictDoUpdate({
      target: projectEnvironmentsTable.projectId,
      set: {
        language: values.language,
        baseImage: values.baseImage,
        setupCommands: values.setupCommands,
        runCommand: values.runCommand,
        dockerfile: values.dockerfile,
      },
    })
    .returning();
  res.json(SetProjectEnvironmentResponse.parse(env));
});

router.delete("/projects/:projectId/environment", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  const params = GetProjectEnvironmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await userOwnsProject(userId, params.data.projectId))) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  await db.delete(projectEnvironmentsTable).where(eq(projectEnvironmentsTable.projectId, params.data.projectId));
  res.sendStatus(204);
});

export default router;
