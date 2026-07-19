# PathForge Pre-Hackathon Baseline

## Purpose of this snapshot

This document records the state of PathForge immediately before new work begins for OpenAI Build Week 2026. It exists to distinguish the pre-existing product from changes made during the competition's submission period.

This baseline was assembled on **July 19, 2026 (Asia/Bangkok)**. OpenAI Build Week's submission period began on **July 13, 2026 at 9:00 AM Pacific Time**. The snapshot commit packages and documents work that already existed locally; the act of committing this snapshot must not be represented as Build Week implementation.

The repository's previous committed tip was `ee81370` (`UPD4`), authored June 28, 2026. At snapshot time there were no commits dated on or after the submission-period start. The newest visible modification timestamps among the pre-existing source files were July 3, 2026. The working tree contained a substantial set of tracked and untracked changes accumulated before this baseline was recorded.

Future Build Week work should be committed separately and should identify the feature implemented, the relevant Codex `/feedback` session ID, and where GPT-5.6 contributed.

## Product state

PathForge is an AI-assisted project-based learning application. A learner supplies or selects a project idea, and the application creates a personalized directed acyclic graph of short learning nodes. Each node represents a focused learning chunk. Learners work through unlocked nodes with an AI tutor, complete steps, and progressively unlock dependent nodes.

The pre-hackathon product includes:

- Clerk-based sign-in, sign-up, user isolation, and protected application routes.
- Learner onboarding and profiles containing education context, interests, experience signals, preferred language, and a generated profile summary.
- AI-generated project recommendations organized by project category.
- Project creation, editing, deletion, status tracking, and personalized description framing/refinement.
- Generation and persistence of project learning maps with nodes and directed edges.
- Node lifecycle states of `locked`, `available`, and `completed`, including automatic unlocking of ready dependents.
- Extra learning nodes that can be spawned when a learner needs prerequisite or supporting material.
- AI-assisted revision and cleanup of future plan nodes while preserving completed work.
- Per-node tutor conversations delivered through server-sent events.
- Structured tutor actions for step updates, node spawning, plan revision, and learner-facing chat.
- Lazy generation of step details and self-contained HTML concept visualizations.
- A step lightbox UI with slide-style content, Markdown/code rendering, chat, and progress controls.
- Persistent chat sessions, summaries, extracted session facts, and project code context used for continuity.
- Node-map canvas navigation, project progress statistics, profile management, and category-specific visual styling.

## Architecture and technology

PathForge is a pnpm workspace monorepo:

| Area | Pre-hackathon implementation |
| --- | --- |
| Frontend | React 19, Vite 7, TypeScript, Wouter, TanStack Query, Tailwind CSS 4, Radix UI |
| API | Express 5 on Node.js, TypeScript, SSE streaming, Pino request logging |
| API contract | OpenAPI source in `lib/api-spec/openapi.yaml`, with generated React Query and Zod clients |
| Authentication | Clerk, including an Express proxy mounted at `/clerk` |
| Database | PostgreSQL with Drizzle ORM |
| AI transport | OpenAI-compatible SDK pointed at OpenRouter |
| AI model | `google/gemini-3.1-flash-lite` |
| Deployment | Render configuration in `render.yaml` |

The OpenAPI document is the API source of truth. Generated files under `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/` reflect the contract and are not intended for manual editing.

## AI behavior before Build Week

All product AI paths currently use `google/gemini-3.1-flash-lite` through OpenRouter. This includes:

- project framing questions and idea refinement;
- personalized project recommendations;
- learning-map generation;
- tutor opening messages and streamed chat;
- step-detail generation;
- plan revision and extra-node generation;
- summaries, extracted learner/session facts, and code-context updates; and
- generated HTML learning visualizations.

No pre-hackathon runtime path is documented as using GPT-5.6. Any Build Week submission must separately identify meaningful work performed with GPT-5.6 in Codex during the submission period. Replacing the runtime model is not necessarily required, but GPT-5.6's contribution to the competition work must be real, attributable, and documented.

## Data model before Build Week

The database contains schemas for:

- users and Clerk-scoped learner profiles;
- stored learner project recommendations;
- projects and project status;
- node maps, nodes, and node edges;
- chat sessions and chat messages;
- project-level code context; and
- legacy conversations/messages retained in the workspace.

Timestamps use ISO string mode. Projects, profiles, recommendations, and all learning data are scoped to the authenticated Clerk user in the application layer.

## API surface before Build Week

The contract includes operations for:

- health checks;
- reading, updating, and deleting a learner profile;
- listing, creating, reading, updating, and deleting projects;
- generating and regenerating project recommendations;
- generating and reading node maps;
- retrieving project progress statistics;
- revising a learning plan;
- reading and sending node tutor messages;
- generating node opening messages, step details, and visualizations;
- spawning extra nodes; and
- updating node status.

The server also contains project-description refinement and framing-question routes used by the project creation flow.

## Known readiness gaps at the baseline

The following were not established as part of this snapshot:

- A root project `README.md` with complete setup, sample-data, and judging instructions. The existing `AIExperience/README.md` only documents the internal AI-quality feedback folder.
- A repository `LICENSE` file, although the root package metadata declares `MIT`.
- A recorded successful clean build or end-to-end test for this exact snapshot.
- A public judging/demo deployment with documented test credentials.
- A Build Week demo video.
- A Build Week Codex `/feedback` session ID.
- Documentation of GPT-5.6 use during the Build Week submission period.

These gaps describe the pre-hackathon state and should not be confused with features implemented after this baseline.

## Build and development commands

```bash
pnpm install
pnpm run typecheck
pnpm run build

pnpm --filter @workspace/app run dev
pnpm --filter @workspace/api-server run dev

pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/db run push
```

Local operation requires Clerk, PostgreSQL, and OpenRouter environment variables as documented in `.env.example` and the repository guidance files.

## Rule for all subsequent competition work

Treat this snapshot as the boundary between pre-existing PathForge and OpenAI Build Week work. Every submission claim about work performed during the event should be traceable to commits after this baseline and supported by the relevant Codex session evidence. The final submission README should explicitly separate:

1. capabilities recorded in this document;
2. meaningful extensions created after the competition start; and
3. the specific roles played by Codex and GPT-5.6 in those extensions.
