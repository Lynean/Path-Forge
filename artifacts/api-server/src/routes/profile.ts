import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, learnerProfilesTable } from "@workspace/db";
import {
  UpsertProfileBody,
  GetProfileResponse,
  UpsertProfileResponse,
} from "@workspace/api-zod";
import { requireAuth, getAuthUserId } from "../lib/auth";

const router: IRouter = Router();

router.get("/profile", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);

  const [profile] = await db
    .select()
    .from(learnerProfilesTable)
    .where(eq(learnerProfilesTable.clerkUserId, userId));

  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  res.json(GetProfileResponse.parse(profile));
});

router.put("/profile", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);

  const parsed = UpsertProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(learnerProfilesTable)
    .where(eq(learnerProfilesTable.clerkUserId, userId));

  let profile;
  if (existing) {
    [profile] = await db
      .update(learnerProfilesTable)
      .set(parsed.data)
      .where(eq(learnerProfilesTable.clerkUserId, userId))
      .returning();
  } else {
    [profile] = await db
      .insert(learnerProfilesTable)
      .values({ clerkUserId: userId, ...parsed.data })
      .returning();
  }

  res.json(UpsertProfileResponse.parse(profile));
});

export default router;
