---
name: PathForge API conventions
description: API, codegen, and AI conventions for PathForge
---

# PathForge API Conventions

**API base:** `/api`

**Codegen:** `pnpm --filter @workspace/api-spec run codegen` — regenerates both `@workspace/api-client-react` and `@workspace/api-zod`. Run after any openapi.yaml change.

**Zod schemas:** imported from `@workspace/api-zod` in the API server routes.

**DB rebuild after schema changes:** `pnpm --filter @workspace/db exec tsc -p tsconfig.json`

**OpenRouter model:** `google/gemini-2.5-flash-lite`, max_tokens: 8192 (node map generation), 2048 (chat), 1024 (opening message), 512 (spawn/summary).

**SSE chat format:** events are `data: {"type": "chunk", "content": "..."}`, `data: {"type": "done"}`, optionally `data: {"type": "extra_node_spawned", "nodeId": N, "title": "..."}`. (Old format used bare `{"content": "..."}` — updated in Task #3.)

**Why:** Consistent event format lets the frontend parse cleanly without ambiguity.
