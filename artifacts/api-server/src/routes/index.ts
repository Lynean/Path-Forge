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

const router: IRouter = Router();

router.use(healthRouter);
router.use(profileRouter);
router.use(nodeMapRouter);
router.use(projectsRouter);
router.use(agentRunsRouter);
router.use(projectWorkspaceRouter);
router.use(projectEnvironmentRouter);
router.use(runtimeRouter);
router.use(settingsRouter);

export default router;
