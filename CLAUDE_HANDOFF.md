# PathForge Coding Agent — Session Handoff

## Checkpoint

Branch: `codex/buildweek`

The repository contains a standalone educational coding-agent harness and Electron
lab. It is intentionally separate from the existing PathForge API and React app so
the next session can integrate it behind a stable boundary.

## Completed

- Typed model/tool harness with streaming, cancellation, budgets and cleanup.
- SOUL, USER and PROJECT context documents.
- Conversation persistence in the Electron lab.
- Workspace inspection: inspect, list, read and literal search.
- Deterministic command and runtime policies.
- Docker isolation with non-root execution, resource limits and no execution network.
- Content-addressed dependency images with cache inventory, LRU pruning and clearing.
- Node 24 using npm or pnpm lockfiles.
- Python 3.13 using uv locks or conservatively pinned pip requirements.
- Python capability detection for pytest, mypy, syntax checking and builds.
- uv source validation limited to PyPI and pythonhosted artifacts.
- Loose Python dependency preparation into a hash-locked `requirements.txt`.
- Exact-context staged file replacement and new-file proposals.
- Staged reads, search, listing, manifest detection and Docker overlays.
- Protected paths, traversal/symlink/binary checks and bounded edit sizes.
- Bounded failing-test → diagnosis → staged patch → identical retest loop.
- Mutation-aware tool history: duplicate calls stay blocked until an edit changes evidence.
- Per-run repair-attempt limits in addition to global turn/tool/time budgets.

## Safety model

```text
User workspace (unchanged)
        |
        | filtered snapshot + in-memory staged overlay
        v
Disposable Docker workspace
        |
        +-- dependency preparation: temporary network access
        |
        +-- tests/build/typecheck: networking disabled
```

The harness is the trusted control plane. Project code and downloaded dependencies
are treated as untrusted execution-plane inputs.

## Verified checkpoint

- 32 harness evaluations passed.
- 2 real Docker repair-loop evaluations passed.
- 11 Python Docker evaluations passed.
- 19 Node Docker evaluations passed.
- Full monorepo typecheck passed.
- Electron production build passed.
- Desktop Docker UI smoke journey passed.
- Evaluation and dependency-preparation containers were cleaned up.

## Local images

```bash
pnpm run agent:build-images
```

This builds:

- `pathforge-agent-sandbox:local`
- `pathforge-python-sandbox:local`

These images are local machine artifacts and are not stored in Git.

## Important limitations

1. Staged edits are in memory and disappear when the desktop process exits.
2. There is no accept/discard UI and no authorized host-workspace write path.
3. `apply_patch` uses exact unique `oldText` replacement, not unified diff parsing.
4. New files require an existing parent directory.
5. A lock prepared for an initially unsupported project is recognized on the next
   agent turn; the tool registry is not rebuilt during the same turn.
6. pip input must resolve to a complete pinned requirements graph. Install uses
   binary wheels and `--no-deps`.
7. Custom Python indexes, Git/path dependencies, Poetry, Conda, native packages,
   GPU and ROS environments are not supported.
8. The deterministic repair model proves orchestration; varied real-model behavior still needs
   scenario evaluations.

## Recommended next integration sequence

1. Add durable staged-change records plus accept/discard APIs and UI.
2. Introduce an `AgentRuntime` composition layer in the API server.
3. Translate `AgentEvent` into the existing chat SSE protocol.
4. Run the new runtime in shadow mode with no database mutation.
5. Add durable runs, approvals, audit events and worker recovery.
6. Select a managed sandbox provider for production.

## Start prompt for Claude Code

```text
Read AGENTS.md, CLAUDE.md, CLAUDE_HANDOFF.md, CODING_AGENT_PROCESS.md and
AGENT_PLAN.md. Inspect git status and preserve all existing work.

Treat artifacts/agent-runtime and artifacts/agent-desktop as the verified coding-agent
lab. Do not rewrite them into the API server.

Begin the fresh app-integration phase by documenting and implementing the smallest
adapter boundary between the existing PathForge chat SSE endpoint and AgentRuntime.
Keep the legacy runtime selectable as a fallback. Do not add database mutations or
host-workspace write approval until their contracts are explicit.

Before editing, report:
1. the current API chat flow,
2. the proposed adapter files,
3. the feature-flag/fallback design,
4. the tests that will prove no regression.
```
