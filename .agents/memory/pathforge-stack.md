---
name: PathForge stack conventions
description: Core stack and server conventions for the PathForge project
---

# PathForge Stack Conventions

**Stack:** Express 5 + Drizzle ORM (mode:"string" timestamps) + PostgreSQL, React + Vite + Tailwind v4 + @tailwindcss/typography, Wouter routing, TanStack Query, shadcn/ui, pnpm monorepo.

**Why:** Established in Task #1 and #2; keep consistent across all tasks.

**How to apply:**
- No `console.log` on server — use `req.log` (pino logger)
- Express 5 async handlers must return `Promise<void>`
- DB timestamps use `mode:"string"` (ISO strings, not Date objects)
- Clerk: `publishableKeyFromHost`, `proxyUrl` unconditional; sign-in/up routes use `path="/sign-in/*?"`
- `nodes.summary` column exists (text, nullable) — used for AI-generated one-liner on completion
