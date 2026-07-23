import { Router, type IRouter } from "express";
import { GetRuntimeCapabilitiesResponse } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { getRuntimeCapabilities } from "../lib/runtimeCapabilities";

const router: IRouter = Router();

router.get("/runtime/capabilities", requireAuth, async (_req, res): Promise<void> => {
  const capabilities = await getRuntimeCapabilities();
  res.json(GetRuntimeCapabilitiesResponse.parse(capabilities));
});

export default router;
