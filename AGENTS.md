# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What This App Does

PathForge is an AI-powered project-based learning app. Users submit a project idea, and the system generates a personalized **node map** — a directed acyclic graph (DAG) of ~15-minute learning chunks tailored to their skill level. Selecting a node opens an AI tutor chat panel. Completing nodes unlocks dependents.

## Monorepo Structure

pnpm workspaces:

- `artifacts/api-server/` — Express 5 + Node 24 backend, bundled to `dist/index.mjs` via esbuild
- `artifacts/app/` — React 19 + Vite 7 SPA (Wouter routing, TailwindCSS 4, Radix UI, React Query)
- `lib/api-spec/` — `openapi.yaml` is the **source of truth** for all endpoints and schemas
- `lib/api-client-react/src/generated/` — Auto-generated TanStack Query hooks (do not edit)
- `lib/api-zod/src/generated/` — Auto-generated Zod schemas (do not edit)
- `lib/db/` — PostgreSQL + Drizzle ORM; schema in `src/schema/`
- `lib/integrations/openrouter_ai_integrations/` — OpenRouter API client

## Common Commands

```bash
# Dev servers
pnpm --filter @workspace/app run dev          # Frontend at port 3000
pnpm --filter @workspace/api-server run dev   # API at port 5000

# Typecheck all workspaces
pnpm run typecheck

# Build all (typecheck + esbuild)
pnpm run build

# Regenerate API client & Zod schemas from openapi.yaml (run after any API change)
pnpm --filter @workspace/api-spec run codegen

# Push DB schema to Postgres (dev only, no migration files)
pnpm --filter @workspace/db run push
```

## Architecture

### API Contract First

`lib/api-spec/openapi.yaml` is the single source of truth. After any endpoint or schema change, run `pnpm codegen`. The OpenAPI title must remain `"Api"` — codegen output filenames and import paths depend on it.

### AI Integration

Single model: `google/gemini-3.1-flash-lite` via OpenRouter. Token limits per task:
- Node map generation (`aiNodeMap.ts`): 8192 tokens
- Chat streaming (`aiNodeChat.ts`): 16384 tokens (raised from 2048 to fit the structured [STEPS_UPDATE]/[SPAWN_*]/[CHAT] response format)
- Opening message: 8192 tokens
- Step detail (lazy per-step content): 4096 tokens
- Spawn/summary: 512 tokens

### Streaming (SSE)

Chat and opening-message endpoints emit `text/event-stream` with JSON events:
```json
{"type": "chunk", "content": "..."}
{"type": "done"}
{"type": "extra_node_spawned", "nodeId": 5, "title": "..."}  // may come after "done"
```

### Auth (Clerk)

Frontend uses a dynamic `publishableKeyFromHost()` + Clerk proxy at `/clerk` (Express proxy middleware). All DB reads/writes are scoped by `clerkUserId`.

### Node Lifecycle

States: `locked` → `available` → `completed`. Also `isExtra` for user-spawned nodes. Marking a node `completed` triggers AI to unlock dependent nodes and generate summaries for context carryover.

### Database Conventions

- All timestamps are ISO strings (`mode: "string"`), not Date objects
- Use `zod/v4` (not `zod`) when importing directly
- Schema index: `lib/db/src/schema/index.ts`

### Server Conventions

- No `console.log` — use `req.log` (pino attached by `pino-http`)
- All async Express handlers must return `Promise<void>` and explicitly `return` after sending response
- Validate route params/bodies with `*.safeParse()`; return `400` on failure

## Key File Locations

| What | Where |
|------|-------|
| API contract | `lib/api-spec/openapi.yaml` |
| DB schema | `lib/db/src/schema/index.ts` |
| AI map generation | `artifacts/api-server/src/lib/aiNodeMap.ts` |
| AI chat streaming | `artifacts/api-server/src/lib/aiNodeChat.ts` |
| Frontend routes | `artifacts/app/src/App.tsx` |
| Node map canvas | `artifacts/app/src/components/node-map-canvas.tsx` |
| Chat panel | `artifacts/app/src/components/node-chat-panel.tsx` |

## Environment Variables

```bash
# Clerk (both frontend and backend need these)
VITE_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
CLERK_PUBLISHABLE_KEY=pk_...
VITE_CLERK_PROXY_URL=http://localhost:5000/clerk

# Database
DATABASE_URL=postgresql://...

# AI
OPENROUTER_API_KEY=sk-or-v1-...
```

## Deployment

Deployed on Render (`render.yaml`). Build: `pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build`. Start: `node --enable-source-maps ./artifacts/api-server/dist/index.mjs`. CORS auto-allows Vercel and Replit domains; others via `ALLOWED_ORIGINS`.
