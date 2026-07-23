import { Router, type IRouter } from "express";
import healthRouter from "./health";
import profileRouter from "./profile";
import projectsRouter from "./projects";
import nodeMapRouter from "./nodeMap";
import agentRunsRouter from "./agentRuns";
import projectWorkspaceRouter from "./projectWorkspace";
import runtimeRouter from "./runtime";

const router: IRouter = Router();

router.use(healthRouter);
router.use(profileRouter);
router.use(nodeMapRouter);
router.use(projectsRouter);
router.use(agentRunsRouter);
router.use(projectWorkspaceRouter);
router.use(runtimeRouter);

export default router;
