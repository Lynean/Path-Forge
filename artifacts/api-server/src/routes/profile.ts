import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, learnerProfilesTable, learnerRecommendationsTable } from "@workspace/db";
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

  const profile = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(learnerProfilesTable)
      .where(eq(learnerProfilesTable.clerkUserId, userId));

    const [savedProfile] = existing
      ? await tx
          .update(learnerProfilesTable)
          .set(parsed.data)
          .where(eq(learnerProfilesTable.clerkUserId, userId))
          .returning()
      : await tx
          .insert(learnerProfilesTable)
          .values({ clerkUserId: userId, ...parsed.data })
          .returning();

    // A recommendation set is derived from the profile. Never keep serving ideas
    // generated for the learner's old interests, level, age, or language.
    await tx
      .delete(learnerRecommendationsTable)
      .where(eq(learnerRecommendationsTable.clerkUserId, userId));

    return savedProfile;
  });

  res.json(UpsertProfileResponse.parse(profile));
});

router.delete("/profile", requireAuth, async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);

  await db
    .delete(learnerProfilesTable)
    .where(eq(learnerProfilesTable.clerkUserId, userId));

  res.sendStatus(204);
});

export default router;
