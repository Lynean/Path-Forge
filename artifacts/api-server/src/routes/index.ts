import { Router, type IRouter } from "express";
import healthRouter from "./health";
import profileRouter from "./profile";
import projectsRouter from "./projects";
import nodeMapRouter from "./nodeMap";
import agentRunsRouter from "./agentRuns";

const router: IRouter = Router();

router.use(healthRouter);
router.use(profileRouter);
router.use(nodeMapRouter);
router.use(projectsRouter);
router.use(agentRunsRouter);

export default router;
