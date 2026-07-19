# PathForge – Copilot Instructions

## Project Overview

PathForge is an AI-powered project-based learning app. Users submit a project idea and receive a personalized **node map** — a DAG of learning topics. Each node has an AI tutor chat. The core UX is a split-view: the node map canvas on the left, and an AI chat panel on the right when a node is selected.

---

## Commands

```bash
# Start API server (port 5000)
pnpm --filter @workspace/api-server run dev

# Run frontend
pnpm --filter @workspace/app run dev

# Full typecheck across all packages
pnpm run typecheck

# Build all packages
pnpm run build

# Regenerate API client + Zod schemas from openapi.yaml (run after ANY openapi.yaml change)
pnpm --filter @workspace/api-spec run codegen

# Push DB schema changes to Postgres (dev only)
pnpm --filter @workspace/db run push
```

**Required env:** `DATABASE_URL` (Postgres connection string), `VITE_CLERK_PUBLISHABLE_KEY`, and Clerk backend keys.

---

## Architecture

### Monorepo Layout

```
artifacts/
  api-server/     # Express 5 API, built with esbuild, runs on Node 24
  app/            # React + Vite frontend
lib/
  api-spec/       # Source of truth: openapi.yaml + orval codegen config
  api-client-react/ # Generated: TanStack Query hooks (do not edit by hand)
  api-zod/        # Generated: Zod request/response schemas (do not edit by hand)
  db/             # Drizzle ORM schema + db client; source of truth for DB shape
  integrations/
    openrouter_ai_integrations/ # OpenRouter AI client (server-side only)
```

### API Contract Flow

`lib/api-spec/openapi.yaml` → `pnpm codegen` → `lib/api-client-react/src/generated/` + `lib/api-zod/src/generated/`

- **Never hand-edit** files in `lib/api-client-react/src/generated/` or `lib/api-zod/src/generated/`.
- API server routes import request/response schemas from `@workspace/api-zod`.
- Frontend uses hooks from `@workspace/api-client-react`.

### Authentication

Clerk is used for auth. The API server runs a Clerk proxy (proxied path: `/clerk`). Both the frontend and backend use `publishableKeyFromHost` to derive the publishable key dynamically from the host. All protected routes use the `requireAuth` middleware from `artifacts/api-server/src/lib/auth.ts`.

### Database

PostgreSQL + Drizzle ORM. Schema lives in `lib/db/src/schema/`. All timestamps use `mode: "string"` — they are ISO strings, not `Date` objects.

---

## Key Conventions

### Server

- **No `console.log`** on the server — use `req.log` (pino logger attached by `pino-http`).
- Express 5 async route handlers must have return type `Promise<void>` and `return` after sending a response.
- Validate all route params and bodies with Zod (`*.safeParse()`), return `400` on failure.
- All data written to or read from the DB is scoped to `clerkUserId` — always filter by user.

### AI

- Model: `google/gemini-2.5-flash-lite` via OpenRouter.
- Token limits: 8192 (node map generation), 2048 (chat), 1024 (opening message), 512 (spawn/summary).
- SSE chat event format:
  ```
  data: {"type": "chunk", "content": "..."}
  data: {"type": "done"}
  data: {"type": "extra_node_spawned", "nodeId": N, "title": "..."}  // optional, after done
  ```

### Frontend Routing (Wouter)

- Both `/projects/:projectId` and `/projects/:projectId/nodes/:nodeId` render the `ProjectDetail` component (split-view).
- `node-detail.tsx` exists but is **not routed** — it's kept for reference. Never route to it.
- Node-level features go in `NodeStepLightbox`, not `NodeChatPanel` (which is kept for reference only).
- When a node is selected, `NodeStepLightbox` opens as a full-screen Dialog with two panels: left = step slider, right = AI side chat.
- `NodeMapCanvas` accepts `onNodeClick` and `selectedNodeId` — selected node shows a ring highlight.

### Zod

- Use `zod/v4` import path (not `zod`).
- DB schemas use `drizzle-zod`'s `createInsertSchema` to derive insert types.

### API Spec Title

The `openapi.yaml` title **must stay `"Api"`** — the codegen output filename (`api.ts`) and imports in `lib/api-client-react` depend on it.
