import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { isLocalMode } from "./lib/localMode";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Clerk is skipped entirely in fully-local mode (no login, no proxy needed).
if (!isLocalMode) {
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
}

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin) ||
        /\.replit\.dev$/.test(origin) ||
        /\.repl\.co$/.test(origin) ||
        /\.vercel\.app$/.test(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (!isLocalMode) {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}

app.use("/api", router);

// Fully-local / packaged app: serve the bundled SPA from this same origin so the
// UI's relative `/api` calls need no dev proxy and no configured API base. Cloud
// deploys serve the UI separately (Vercel) and ship no `dist/public`, so this
// whole block no-ops there. Path is overridable for the packaged layout.
const appDist =
  process.env.PATHFORGE_APP_DIST ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app/dist/public");

if (existsSync(path.join(appDist, "index.html"))) {
  app.use(express.static(appDist));
  // SPA fallback: any non-API GET returns index.html so client-side routing works
  // on deep links / refresh. `/api` and `/clerk` are handled above and skipped here.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/clerk")) return next();
    res.sendFile(path.join(appDist, "index.html"));
  });
  logger.info({ appDist }, "Serving bundled UI (same-origin)");
}

export default app;
