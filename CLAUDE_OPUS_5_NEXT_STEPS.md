# Handoff Prompt for Claude Opus 5

Copy everything inside the prompt block into a new Claude Code session opened at
the repository root.

```text
You are taking over PathForge on branch `codex/buildweek`. Assume you have never
seen this repository or any preceding conversation. Do not rely on memory from a
different checkout.

FIRST: ORIENT WITHOUT EDITING

1. Read these files completely, in this order:
   - AGENTS.md
   - CLAUDE.md
   - CLAUDE_HANDOFF.md
   - CODING_AGENT_PROCESS.md
   - AGENT_PLAN.md
   - HABITTRACKER_HARNESS_RETEST.md
   - TYPESCRIPT_TASKBOARD_CLI_RETEST.md
2. Inspect `git status -sb`, the recent commit history, and the relevant source.
3. Run the deterministic non-Docker checkpoint before changing anything:
   `pnpm run agent:verify`.
4. Report back briefly with:
   - the current harness/CLI architecture as you found it,
   - the evidence behind the four defects below,
   - the exact files and tests you intend to change.
5. Then proceed autonomously unless you discover a scope-changing ambiguity.

REPOSITORY STATE YOU ARE INHERITING

PathForge is a pnpm monorepo. The BuildWeek branch now contains:

- `artifacts/agent-runtime`: the headless coding-agent harness, Docker sandbox,
  runtime detection/policy, staged tools, protected code graph, and evals.
- `artifacts/agent-desktop`: the Electron lab.
- `artifacts/pathforge-cli`: a small CLI/API client used to test the real tutor
  and node-map pipelines against arbitrary local projects without rebuilding the
  desktop UI.
- API-server harness integration, learning-plan correction tools, code retrieval,
  response guards, memory refreshes, and HabitTracker deterministic replays.
- Two real-model retest reports at repository root.

The latest larger retest used a multi-file strict TypeScript TaskBoard project:
5 nodes, 15 generated steps, JSON persistence, branded IDs, repositories,
services, CLI parsing, and 19 passing tests. The finished fixture passed host
typecheck/tests and a real add -> list -> complete -> filtered-list workflow.

The final program succeeded, but the run exposed four harness defects that must
be addressed BEFORE starting fresh app integration.

GOAL

Turn the real-model failures into deterministic protections and fix the root
causes in this order:

1. fresh code-graph retrieval,
2. safe project-declared package scripts plus command retry protection,
3. DAG-wide learning-plan correction propagation,
4. evidence-bound command responses and cumulative memory.

Preserve the public `AgentRuntime` boundary and the trusted-control-plane versus
untrusted-sandbox separation. Do not rewrite the lab into the API server. Do not
write staged agent edits into a user's real workspace. Keep network disabled for
normal execution and do not weaken path, command, resource, or secret controls.

WORKSTREAM 1 — GRAPH FRESHNESS (DO THIS FIRST)

Observed evidence:

- At the end of the TypeScript retest, the real `src/app.ts` supported add,
  complete, and filtered list.
- `graph/project_graph.json` still held the initial add/list-only version.
- The generator therefore performed apparently successful searches against old
  source and taught duplicate or obsolete work.
- It also failed to retrieve a test helper created earlier in the same session.

Relevant starting points:

- `artifacts/agent-runtime/src/tools/project-graph-store.ts`
- `artifacts/agent-runtime/src/code-graph/project-graph.ts`
- `artifacts/agent-runtime/src/tools/graph-search-tool.ts`
- `artifacts/agent-runtime/src/tools/graph-parent-tool.ts`
- `artifacts/agent-runtime/src/tools/workspace-edit-tool.ts`
- `artifacts/api-server/src/lib/agent/harness-runtime.ts`
- `artifacts/pathforge-cli/src/server.ts`

Required behavior:

- Determine the actual lifetime of every `ProjectGraphStore`; do not assume the
  stale file alone proves where caching occurs.
- A search result must correspond to the current workspace/staged-overlay bytes.
- Use existing SHA-256 file hashes as freshness evidence.
- After a staged edit or detected host-file change, invalidate/rebuild only what
  is necessary. A correct bounded full rebuild is acceptable as an initial
  implementation if it is simpler and deterministic; document the scaling path
  to incremental per-file indexing.
- Never expose the protected graph file as an ordinary learner file.
- Avoid rebuilding the graph once per tool call when no source changed.

Add deterministic tests that:

- build/search a graph, edit a source file, search again, and prove the new code
  and new hash are returned;
- create a helper during one step and prove a later step can retrieve it;
- prove unchanged workspaces reuse the cached graph;
- prove staged overlays are indexed while the host workspace remains unchanged.

Why first: better prompts cannot compensate for retrieval that confidently
returns old code. Every later learning and repair decision depends on this.

WORKSTREAM 2 — COMMAND POLICY AND OPERATION-LEVEL RETRY PROTECTION

Observed persisted event sequence when the learner asked for
`pnpm run check` exactly once:

1. `pnpm run check` -> `ARGUMENTS_NOT_ALLOWED`
2. `pnpm check` -> `ARGUMENTS_NOT_ALLOWED`
3. `pnpm` -> `ARGUMENTS_NOT_ALLOWED`
4. `npm test` -> exit 0, 19 tests passed

The runtime currently hard-codes Node scripts to `test`, `typecheck`, and
`build`, so a safe project-declared `check` script is rejected. The harness's
duplicate protection compares concrete calls/evidence, so aliases for the same
requested operation evade it.

Relevant starting points:

- `artifacts/agent-runtime/src/environment/runtime-plan.ts`
- `artifacts/agent-runtime/src/environment/runtime-detector.ts`
- `artifacts/agent-runtime/src/environment/runtime-policy.ts`
- `artifacts/agent-runtime/src/policy/command-policy.ts`
- `artifacts/agent-runtime/src/runtime/harness.ts`
- `artifacts/agent-runtime/src/tools/run-command-tool.ts`

Required behavior:

- Parse scripts from the snapshotted/staged `package.json` in trusted code.
- Permit a deliberately bounded set of project-declared verification scripts
  such as `check`, while preserving structured executable/argument matching,
  safe working directories, time/output budgets, no command-specific env, no
  shell evaluation, and sandbox isolation.
- Do NOT recursively trust arbitrary script chains merely because a name exists.
  Define and test a clear policy. If script-body analysis cannot safely approve
  it, return an explicit approval/unsupported result instead of guessing.
- Normalize an intended operation separately from concrete syntax so one request
  does not fan out into `pnpm run check`, `pnpm check`, bare `pnpm`, and
  `npm test` after policy rejection.
- A policy rejection is evidence. The next model turn should report it or choose
  a single explicitly valid action, not probe aliases.
- Preserve the existing rule that the same test may run again after a real staged
  mutation advances the evidence revision.

Add deterministic tests for:

- an approved project `check` script executing exactly once;
- an unsafe/unknown project script remaining rejected;
- one policy rejection causing no equivalent alias calls;
- the normal fail -> patch -> identical retest repair loop still working.

Why second: repeated command execution wastes tool budget and makes the tutor's
evidence untrustworthy even though the sandbox itself is isolated.

WORKSTREAM 3 — DAG-WIDE CORRECTION PROPAGATION

Observed evidence:

- A session correction said repository wiring was already complete and requested
  completion logic instead.
- The regenerated current node still repeated the stale wiring premise.
- After manually repurposing that node, the next sibling node duplicated the
  completion work.
- Filename/architecture corrections can therefore update the open session while
  leaving sibling/dependent nodes stale.

Relevant starting points:

- `artifacts/api-server/src/lib/agent/tools/plan-proposal-tools.ts`
- `artifacts/api-server/src/lib/agent/learning-plan-guards.ts`
- `artifacts/api-server/src/lib/agent/harness-runtime.ts`
- `artifacts/api-server/src/routes/nodeMap.ts`
- `artifacts/api-server/src/lib/agent/evals/habittracker-replay.ts`

Required behavior:

- Introduce a validated DAG-wide replan proposal, or strengthen
  `regenerate_session` so foundational corrections can update affected current,
  sibling, and dependent nodes atomically.
- Keep completed learner work and unaffected nodes stable.
- Validate ownership, node IDs, DAG acyclicity, state transitions, and bounded
  change size in trusted application code before persistence.
- Record why each node changed and what completed capability now satisfies or
  replaces its former goal.
- Do not let the model directly mutate the database.
- Maintain the existing concise response guard: when a correction tool succeeds,
  do not repeat the entire regenerated lesson in chat.

Add a deterministic replay where Node A is corrected to consume Node B's planned
work, then assert Node B and its dependents are replanned without duplicating the
completed capability.

Why third: local correction tools work, but a learning map is a connected plan.
Fixing only the visible step lets contradictions move downstream.

WORKSTREAM 4 — EVIDENCE-BOUND RESPONSES AND MEMORY SCOPE

Observed evidence:

- The tutor reported only the final successful `npm test`, omitting the three
  preceding policy rejections and the fact that the requested command was not
  executed.
- `PROJECT.md` had a current file snapshot but its prose described only the final
  testing node, not the complete product state.
- `USER.md` stored generalized architecture preferences inferred from corrections
  made in one project. They were not explicit user facts.

Required behavior:

- Build command summaries deterministically from structured tool events: exact
  command, attempts, policy rejections, exit code, timeout/truncation, and test
  count when parseable. The model may explain this evidence but not replace it.
- If the requested command was substituted, say so explicitly.
- Make `PROJECT.md` cumulative: current capabilities, architecture, relevant
  files, verified checks, and unresolved issues—not merely the last completed
  node's summary.
- Separate explicit durable user facts from tentative inferred preferences.
  Prefer repeated evidence or an `inferred` marker before promotion. Never place
  project-specific implementation details in `USER.md`.

Add replay tests covering those exact conditions.

VERIFICATION AND DELIVERY

After each workstream, run its focused deterministic eval. At the end run:

- `pnpm run agent:verify`
- `pnpm run typecheck`
- Docker-focused verification if Docker Desktop and the local images are
  available: `pnpm run agent:verify:docker`

Do not hide a failure caused by unavailable Docker; report it separately from a
code failure. Preserve unrelated worktree changes.

Finish with:

1. a concise root-cause story for each fixed defect,
2. the exact changed files,
3. the deterministic regression that proves each fix,
4. verification results,
5. remaining limitations,
6. the next recommended phase.

The next recommended phase only after these protections pass is the app adapter:
compose `AgentRuntime` in the API server, translate `AgentEvent` to the existing
SSE protocol, keep the legacy runtime behind a feature flag, and begin read-only
shadow mode. Do not begin durable workspace writes or production sandbox-provider
selection in the same change.
```
