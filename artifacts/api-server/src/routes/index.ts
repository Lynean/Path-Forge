import { Router, type IRouter } from "express";
import healthRouter from "./health";
import profileRouter from "./profile";
import projectsRouter from "./projects";

const router: IRouter = Router();

router.use(healthRouter);
router.use(profileRouter);
router.use(projectsRouter);

export default router;
