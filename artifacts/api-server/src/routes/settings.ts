import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  setOpenRouterApiKey,
  isOpenRouterConfigured,
} from "@workspace/integrations-openrouter-ai";
import { requireAuth } from "../lib/auth";
import { isLocalMode } from "../lib/localMode";

const router: IRouter = Router();

// BYO-key settings are only meaningful in the fully-local app, where the user
// supplies their own OpenRouter key. In cloud mode the key comes from server
// env and must never be user-settable, so these endpoints 404 there.
function localOnly(res: import("express").Response): boolean {
  if (!isLocalMode) {
    res.status(404).json({ error: "Not found" });
    return false;
  }
  return true;
}

const SetKeyBody = z.object({ apiKey: z.string().min(1).max(400) });

// Reports only whether a key is configured — never returns the key itself.
router.get("/settings/openrouter", requireAuth, (req, res): void => {
  if (!localOnly(res)) return;
  res.json({ configured: isOpenRouterConfigured() });
});

// Sets the runtime key (held in memory by the integration client). Persistence +
// encryption-at-rest is the Electron main's job (safeStorage); it re-pushes the
// key here on each backend start. The key never transits back out of the server.
router.put("/settings/openrouter", requireAuth, (req, res): void => {
  if (!localOnly(res)) return;
  const parsed = SetKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  setOpenRouterApiKey(parsed.data.apiKey);
  res.json({ configured: isOpenRouterConfigured() });
});

// Clears the runtime key (does not touch the main process's stored copy).
router.delete("/settings/openrouter", requireAuth, (req, res): void => {
  if (!localOnly(res)) return;
  setOpenRouterApiKey(null);
  res.json({ configured: isOpenRouterConfigured() });
});

export default router;
