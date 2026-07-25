import { Router, type IRouter } from "express";
import healthRouter from "./health";
import profileRouter from "./profile";
import projectsRouter from "./projects";
import nodeMapRouter from "./nodeMap";
import agentRunsRouter from "./agentRuns";
import projectWorkspaceRouter from "./projectWorkspace";
import projectEnvironmentRouter from "./projectEnvironment";
import runtimeRouter from "./runtime";
import settingsRouter from "./settings";
import projectShareRouter from "./projectShare";
import { isChatOnlyMode } from "../lib/chatOnly";

const router: IRouter = Router();

router.use(healthRouter);
router.use(profileRouter);
router.use(nodeMapRouter);
router.use(projectShareRouter);
router.use(projectsRouter);
router.use(agentRunsRouter);
// Folder/command/Docker/WASM surface — omitted entirely in pure-chat web mode.
if (!isChatOnlyMode) {
  router.use(projectWorkspaceRouter);
  router.use(projectEnvironmentRouter);
  router.use(runtimeRouter);
}
router.use(settingsRouter);

export default router;
