import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { isLocalMode, LOCAL_USER_ID } from "./localMode";

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  // Fully-local desktop: single on-device user, no login. Every request is the
  // local user.
  if (isLocalMode) {
    (req as any).userId = LOCAL_USER_ID;
    next();
    return;
  }

  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as any).userId = userId;
  next();
};

export const getAuthUserId = (req: Request): string => {
  return (req as any).userId as string;
};
