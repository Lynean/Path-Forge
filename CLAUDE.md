# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- `lib/integrations-openrouter-ai/` — `@workspace/integrations-openrouter-ai`, the OpenRouter API client (`src/client.ts`, `src/batch/`)
- `artifacts/agent-runtime/` — `@workspace/agent-runtime`, the headless coding-agent library (model adapters, Docker sandbox, tools, policy, eval suites)
- `artifacts/agent-desktop/` — Electron harness that drives `AgentRuntime` in a UI; the lab for agent work
- `artifacts/mockup-sandbox/` — standalone Vite playground for UI mockups; not wired into the app
- `scripts/` — one-off tsx scripts

Note: `lib/integrations/openrouter_ai_integrations/` is a stale leftover with no
`package.json`. It is not a workspace and nothing imports it — do not add code there.

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

`pnpm` is mandatory — a `preinstall` guard rejects npm/yarn.

### Tests

There is no unit-test framework. Verification is the agent eval suites, each a
plain tsx entry point under `src/evals/` that you can run individually:

```bash
pnpm --filter @workspace/agent-runtime run eval           # in-process, no Docker
pnpm --filter @workspace/agent-runtime run eval:repair    # repair-loop suite (Docker)
pnpm --filter @workspace/agent-runtime run eval:docker    # Node sandbox (Docker)
pnpm --filter @workspace/agent-runtime run eval:docker:python
pnpm --filter @workspace/agent-desktop run eval
pnpm --filter @workspace/agent-desktop run eval:docker-ui

# Build the two sandbox images the Docker suites need
pnpm run agent:build-images
```

### Dependency policy

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` (1-day quarantine on new npm
releases) as supply-chain defense — do not lower or remove it. It also pins
`overrides` that strip every non-`win32-x64` esbuild/rollup/lightningcss/oxide
binary; installing on macOS or Linux requires removing those overrides first.

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
- Routes live in `src/routes/` (`projects.ts`, `nodeMap.ts`, `profile.ts`, `health.ts`); protect them with `requireAuth` from `src/lib/auth.ts`

### Frontend Conventions

- Both `/projects/:projectId` and `/projects/:projectId/nodes/:nodeId` render the
  same `ProjectDetail` split view. `pages/node-detail.tsx` exists but is
  deliberately **not routed** — keep it that way.
- Node-level features belong in `node-step-lightbox.tsx` (full-screen Dialog:
  step slider left, AI side chat right), not `node-chat-panel.tsx`, which is
  retained for reference only.
- `NodeMapCanvas` takes `onNodeClick` + `selectedNodeId`; the selection is drawn as a ring.

### Agent Runtime (`artifacts/agent-runtime/`)

The public boundary is intentionally narrow:

```ts
interface AgentRuntime {
  runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

Consumers import only from the package root (`src/index.ts`) — never reach into
Docker, OpenRouter, or individual tools directly; those are harness internals.
Trusted control plane (model routing, command policy, budgets, staged-edit
limits, approvals) is separated from the untrusted execution plane (project
source, dependencies, test/build processes), which never receives app secrets or
DB credentials. Edits are *staged* and returned as a bounded diff; nothing is
written into a real workspace.

## Key File Locations

| What | Where |
|------|-------|
| API contract | `lib/api-spec/openapi.yaml` |
| DB schema | `lib/db/src/schema/index.ts` |
| AI map generation | `artifacts/api-server/src/lib/aiNodeMap.ts` |
| AI chat streaming | `artifacts/api-server/src/lib/aiNodeChat.ts` |
| AI visualization | `artifacts/api-server/src/lib/aiVisualize.ts` |
| Frontend routes | `artifacts/app/src/App.tsx` |
| Node map canvas | `artifacts/app/src/components/node-map-canvas.tsx` |
| Node step lightbox (active node UI) | `artifacts/app/src/components/node-step-lightbox.tsx` |
| Chat panel (reference only) | `artifacts/app/src/components/node-chat-panel.tsx` |
| Agent runtime public API | `artifacts/agent-runtime/src/index.ts`, `src/contracts.ts` |
| Agent turn loop | `artifacts/agent-runtime/src/runtime/agent-runtime.ts`, `src/runtime/harness.ts` |
| Agent sandboxing | `artifacts/agent-runtime/src/sandbox/`, `docker/Dockerfile{,.python}` |

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

## BuildWeek coding-agent checkpoint

Before changing the coding-agent or beginning app integration, read:

1. `CLAUDE_HANDOFF.md` for the verified implementation state and known limitations.
2. `CODING_AGENT_PROCESS.md` for the packaged runtime workflow and integration boundary.
3. `AGENT_PLAN.md` for the longer-term architecture and rollout plan.
4. `AGENTS.md` for any additional repository-agent instructions.

The verified lab lives in `artifacts/agent-runtime/` and
`artifacts/agent-desktop/`. Preserve unrelated changes and do not write staged
agent edits into a real workspace until an explicit accept/discard flow exists.

The next phase is app integration, not a rewrite of the lab. Introduce an adapter
between PathForge's API/SSE contracts and `AgentRuntime`, with the legacy AI flow
available as a fallback.

```bash
# Deterministic checkpoint
pnpm run agent:verify

# Docker Desktop and local images required
pnpm run agent:verify:docker
```

## Sibling agent-instruction files

`AGENTS.md` (Codex) mirrors this file almost verbatim, and
`.github/copilot-instructions.md` covers the same ground in its own format. All
three are currently in sync — when you change a convention here, mirror it in
both.
