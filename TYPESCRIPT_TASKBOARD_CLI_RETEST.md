# PathForge CLI Retest: TypeScript TaskBoard

Date: 2026-07-31

## Result at a glance

PathForge completed a real, larger TypeScript learning project with:

- 5 learning nodes
- 15 generated implementation steps
- 13 indexed source/test files and 94 graph nodes
- strict TypeScript with NodeNext imports
- a domain -> port -> repository -> service -> CLI architecture
- JSON persistence, completion by branded ID, filters, and error handling
- 19 passing tests

Final host verification:

```text
pnpm run check
typecheck: passed
tests: 19 passed, 0 failed
```

Final manual workflow also passed: add a high-priority task, list it as open,
complete it, restart the program for each command, then list it as completed.

The final project is successful. The harness is not yet reliable enough to let
the generated lesson drive implementation without review.

## The test project

The fixture deliberately began as a partially implemented multi-file project.
It already had:

- a branded `TaskId`
- `Task` domain types
- a `TaskRepository` port
- an in-memory repository
- a JSON repository stub
- a service layer
- an argument parser and CLI entry point
- five baseline tests

The requested work was to preserve that architecture while adding JSON
persistence, complete-by-ID, filtering, matching commands, and focused tests.

## Journey through the generated map

### Node 1: Repository Integration

Expected before opening: implement JSON reading/writing while preserving exact
domain types and treating only a missing file as an empty repository.

What happened:

- File reading and upsert persistence were mostly correct.
- The first lesson swallowed every read error instead of only `ENOENT`.
- A generated test repeatedly invented invalid domain values: a plain string ID,
  `status: "todo"`, a `Date` instead of an ISO string, and missing fields.
- Two corrections were needed before the lesson matched the real domain.

### Node 2: Service Wiring

Expected before opening: connect existing repository behavior to the service and
implement completion with a useful missing-ID error.

What happened:

- The node was stale: the real entry point already used `JsonTaskRepository`.
- A whole-session correction was accepted, but the regenerated first step still
  repeated the stale wiring premise.
- Individual step corrections eventually produced a correct `completeTask` and
  service tests.
- One regenerated step invented Vitest although the project uses `node:test`.

### Node 3: Task Completion

Expected before opening: extend parsing and application dispatch for the
complete command, reusing the service implementation from Node 2.

What happened:

- The original node duplicated service work that Node 2 had already completed.
- Regeneration successfully refocused the node on the CLI boundary.
- One lesson suggested `console.log` and local error handling inside `runApp`,
  contradicting its established `Promise<string[]>` contract.
- Corrections produced parser and application integration tests.

### Node 4: Filtering Logic

Expected before opening: parse validated status/priority flags and apply filters
inside repositories through the existing `findAll(filter)` contract.

What happened:

- Retrieval first searched for a nonexistent `src/cli/index.ts`, then recovered.
- A lesson again invented the status `"todo"` instead of `"open"`.
- Another lesson moved filtering into `TaskService`, contradicting both the
  repository port and the in-memory implementation.
- Correction restored filtering to `JsonTaskRepository`.

### Node 5: Extended Testing

Expected before opening: verify persistence across repository instances,
complete-and-filter through `runApp`, and malformed JSON behavior.

What happened:

- The first integration-test direction was useful.
- Later steps forgot the test helper created earlier in the same node.
- The final generated test referenced a nonexistent `setup()`, directly mutated
  a task instead of using the CLI, and completed a low-priority task while
  expecting it from a completed-and-high filter.
- A precise correction produced the intended integration coverage.

## Most important discovery: retrieval used stale code

The project graph was generated at the beginning and was not refreshed after
the project changed. At the end of the run, the graph's stored copy of
`src/app.ts` still supported only add/list, while the real file already supported
complete and filtering.

This explains several apparently mysterious failures:

```text
real file changes
      |
      v
graph remains unchanged
      |
      v
step generator searches successfully
      |
      v
generator receives old code and teaches obsolete work
```

This is more fundamental than ordinary summarization. The retrieval mechanism
can return a confident, relevant, but outdated result.

Recommended fix: refresh changed graph entries after accepted edits, and attach
the indexed file hash to retrieval results. Before using a result, compare that
hash with the current workspace file. If it differs, re-index that file first.

## Docker command audit

The event log proves the UI's repeated tool indicators were real calls, not just
duplicate rendering.

First request (`pnpm run check` exactly once):

1. `pnpm run check` was rejected by policy.
2. The model substituted `pnpm test`.
3. That command failed because the Windows lock/install contained the native
   esbuild package for Windows but the sandbox was Linux.

After replacing `tsx`/esbuild with portable `tsc` + `node --test`, the retry did:

1. `pnpm run check` -> policy rejected
2. `pnpm check` -> policy rejected
3. `pnpm` -> policy rejected
4. `npm test` -> exit 0, 19 tests passed

The tutor then accurately reported the command it actually ran (`npm test`), but
it did not explain that three policy rejections preceded it or that it had
violated the request to execute exactly once.

This reveals two separate harness issues:

- The policy understands only a fixed package-script allowlist and rejected a
  valid script declared in this project's `package.json`.
- The loop treats policy rejections as reasons to guess alternate commands,
  rather than reporting the rejection or asking for approval. It also has no
  semantic duplicate-operation guard across different spellings.

## Memory audit

`PROJECT.md` was refreshed after the final node and its bounded file tree is
current. Its prose, however, describes only the final testing milestone rather
than summarizing the whole current product.

`USER.md` did not contain the project name or implementation state. It did infer
general preferences such as strict domain types and layered CLI architecture.
Those are reusable preferences, but they came from project corrections rather
than explicit user declarations, so they should ideally be stored as tentative
inferences or require repeated evidence.

## What worked well

- The CLI completed all nodes without crashing on invalid tool arguments.
- Step and session correction tools were concise and operational.
- Graph searches completed without the timeouts seen in the earlier one-file
  HabitTracker run.
- The sandbox exposed a real cross-platform dependency defect.
- The finished code preserves the requested architecture and strict types.
- Host verification and a real multi-process persistence workflow both pass.

## What the harness should improve next

Priority order:

1. **Incremental graph freshness**: re-index accepted changes and reject stale
   retrieval results by content hash.
2. **Grounding bundles**: when teaching a symbol, retrieve its types, interface,
   consumer, implementation peer, and nearest tests—not just one matching file.
3. **DAG-wide replanning**: when one node absorbs another node's work, update
   dependent/sibling node descriptions instead of correcting only the open node.
4. **Dynamic script policy**: safely allow scripts declared by the snapshotted
   `package.json`, subject to the same sandbox and resource limits.
5. **Operation-level retry protection**: after a policy rejection, do not guess
   equivalent commands repeatedly; surface the exact rejection and next valid
   action.
6. **Evidence-bound responses**: command claims must be generated from the final
   structured tool result and include rejected attempts when relevant.
7. **Memory scope**: make `PROJECT.md` cumulative and mark inferred user
   preferences separately from explicit profile facts.

## Suggested deterministic regressions

Convert the observed failures into replay tests:

- edit `src/app.ts`, search it again, and assert retrieval returns the new hash
- correct a node so it consumes a sibling's task, then assert the sibling replans
- declare a safe `check` script and assert one requested command causes one run
- reject a command by policy and assert the model does not try aliases
- ground a generated `Task` literal and assert every field/value matches its type
- create a test helper during Step 1 and assert Step 3 retrieves that new helper

These replays would make this test useful permanently: future harness changes
could prove they fixed the observed behavior without spending model tokens on
the entire five-node journey again.
