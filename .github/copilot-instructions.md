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

`pnpm` is mandatory — a `preinstall` guard rejects npm/yarn.

**Required env:** `DATABASE_URL` (Postgres connection string), `OPENROUTER_API_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, and Clerk backend keys (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PROXY_URL`).

### Tests

There is no unit-test framework. Verification is the agent eval suites, each a
plain tsx entry point under `src/evals/` that can be run individually:

```bash
pnpm run agent:verify         # typecheck + non-Docker suites
pnpm run agent:build-images   # build the two sandbox images
pnpm run agent:verify:docker  # Docker Desktop + local images required

pnpm --filter @workspace/agent-runtime run eval            # in-process, no Docker
pnpm --filter @workspace/agent-runtime run eval:repair
pnpm --filter @workspace/agent-runtime run eval:docker
pnpm --filter @workspace/agent-runtime run eval:docker:python
pnpm --filter @workspace/agent-desktop run eval
pnpm --filter @workspace/agent-desktop run eval:docker-ui
```

### Dependency policy

`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` (1-day quarantine on new npm
releases) as supply-chain defense — do not lower or remove it. It also pins
`overrides` stripping every non-`win32-x64` esbuild/rollup/lightningcss/oxide
binary; installing on macOS or Linux requires removing those overrides first.

---

## Architecture

### Monorepo Layout

```
artifacts/
  api-server/     # Express 5 API, built with esbuild, runs on Node 24
  app/            # React + Vite frontend
  agent-runtime/  # Headless coding-agent library (model adapters, Docker sandbox, tools, evals)
  agent-desktop/  # Electron harness driving AgentRuntime; the lab for agent work
  mockup-sandbox/ # Standalone Vite playground for UI mockups; not wired into the app
lib/
  api-spec/       # Source of truth: openapi.yaml + orval codegen config
  api-client-react/ # Generated: TanStack Query hooks (do not edit by hand)
  api-zod/        # Generated: Zod request/response schemas (do not edit by hand)
  db/             # Drizzle ORM schema + db client; source of truth for DB shape
  integrations-openrouter-ai/ # @workspace/integrations-openrouter-ai (server-side only)
scripts/          # One-off tsx scripts
```

`lib/integrations/openrouter_ai_integrations/` is a stale leftover with no
`package.json` — it is not a workspace and nothing imports it. Don't add code there.

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

- Model: `google/gemini-3.1-flash-lite` via OpenRouter.
- Token limits: 8192 (node map generation, `aiNodeMap.ts`), 16384 (chat streaming, `aiNodeChat.ts` — raised from 2048 to fit the structured `[STEPS_UPDATE]`/`[SPAWN_*]`/`[CHAT]` response format), 8192 (opening message), 4096 (lazy per-step detail, and `aiVisualize.ts`), 512 (spawn/summary).
- A stream that ends with a `finish_reason` other than `"stop"` (i.e. truncated at `max_tokens`) is treated as a failure, not a partial success — don't "fix" that by swallowing it.
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

---

## Coding Agent (`artifacts/agent-runtime/`)

The public boundary is intentionally narrow:

```ts
interface AgentRuntime {
  runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

Import only from the package root (`src/index.ts`) — never reach into Docker,
OpenRouter, or individual tools directly; those are harness internals. The
trusted control plane (model routing, command policy, budgets, staged-edit
limits, approvals) is separated from the untrusted execution plane (project
source, dependencies, test/build processes), which never receives app secrets or
DB credentials. Edits are *staged* and returned as a bounded diff — never written
into a real workspace. Before changing the agent, read `CLAUDE_HANDOFF.md`,
`CODING_AGENT_PROCESS.md`, and `AGENT_PLAN.md`.

---

## Sibling instruction files

`CLAUDE.md` and `AGENTS.md` (Codex) cover the same ground and are authoritative.
When you change a convention here, mirror it in both.
