# PathForge Harness Retest — HabitTracker

Test date: 2026-07-31
Learner role: 12-year-old beginner
Workspace: `.retest/run2/HabitTracker`
Project: **Habit Tracker (command line)**

## Goal

Repeat the original HabitTracker CLI journey against the real OpenRouter model
after the harness fixes. Record the expectation before every generated step,
compare it with the actual lesson, implement the project through PathForge, and
retest the nine original findings.

The project brief required:

- `python habits.py`
- add, list, and done commands
- consecutive-day streaks
- JSON persistence in the project folder
- no GUI, web framework, database, login, syncing, packaging, publishing, or CI
- roughly 5–8 nodes

## Final result

- Node map: **7 nodes** — within the expected 5–8.
- Nodes completed: **7/7**.
- Primary steps opened: **23/23**.
- Final application: **working**.
- Filename consistency: **pass** after the live invariant-handoff fix.
- Step boundaries: **pass** after adding future-node boundaries.
- Correction isolation: **pass** — correction turns used correction tools only.
- Invalid correction arguments: **pass** — no CLI termination.
- Python execution: **pass** — one execution and a real traceback.
- PROJECT/USER separation: **pass**.
- Graph retrieval: **no timeout during the completed journey**.

## Original findings: before versus now

| Original finding | Live retest result |
|---|---|
| Correction turns called unrelated file tools and failed | Filename and detail corrections used only `regenerate_session`, `regenerate_step_with_notes`, and/or `update_step_description`. No correction turn read or edited project files. |
| Invalid tool arguments terminated the CLI | Recoverable harness rejection remained in the node. No CLI termination occurred. |
| Filename correction did not propagate to siblings | A whole-session correction was used. The first retest exposed that the invariant reached the overview but not lazy details; the backend now embeds the trusted reason in every step note. Regenerated details consistently used `habits.py`. |
| Steps implemented later work early | Same-session DONE/NEXT boundaries worked. A live Date Logic step initially consumed Logic Core's `list` work; future-node briefs are now also hard deny-lists. The regenerated step became an isolated date test. |
| `run_python` ran three times | It ran exactly once. A live loop after the cap was fixed by removing capped tools from subsequent model turns and adding an evidence-finalization instruction. |
| Tutor did not quote the real traceback | Final retest quoted the real Pyodide traceback, `File "<exec>", line 36`, and `KeyError: 'missing'`. |
| PROJECT.md became stale | It refreshed after each completion. Completion-mode inspection now reports achieved state, mentions tests, and appends a deterministic workspace inventory. |
| USER.md contained project information | Final USER.md contains only `Age: 12`; no filenames, technology, code, or current project. |
| Graph search timed out on a one-file project | No retrieval timeout occurred across 23 opened steps. Some steps used several bounded searches, but all completed or fell back successfully. |

## New defects discovered and fixed during the live retest

### 1. Session invariant did not reach lazy details

Interaction:

> I'm 12 and this is confusing: this step uses schema_draft.py, but the project
> brief requires python habits.py. Please correct the lesson plan so habits.py
> is used consistently in this step and every sibling step. Do not inspect or
> edit files during this plan correction.

Tool activity: `regenerate_session` only.

The regenerated overview used `habits.py`, but the first lazy detail invented
`schema.py`. The trusted correction reason is now added to every regenerated
step's hidden `CORRECTION ISSUE` handoff. After repeating the correction, Step 1
used `habits.py`, and the remaining session retained it.

### 2. Whole-session correction printed redundant lesson content

`regenerate_session` originally bypassed the concise correction-response rule.
It is now treated like the two step-correction tools, so the learner receives a
short action confirmation rather than a duplicated step page.

### 3. CLI navigation context misclassified a crash as plan feedback

The CLI prepends `[Context: I'm on step 3 ...]`. The classifier counted that
injected word `step` together with the learner's word `fix`, entered
correction-only mode, and hid execution tools. The classifier now strips the
transport prefix before deciding whether the learner is correcting the plan.

### 4. A capped Python tool still caused a model-turn loop

The first corrected crash attempt executed `run_python` once, then the model
kept requesting it until the 12-turn limit. Once a capped tool completes, it is
now removed from subsequent tool definitions and its observation explicitly
instructs the model to answer from the existing evidence.

### 5. Pyodide could not resolve from an eval worker

The worker was launched from the monorepo root, while `pyodide` was installed in
the API workspace. Bare module resolution failed. The parent module now resolves
the exact `pyodide.mjs` path and passes it to the worker. Independent WASM tests
now pass stdout capture, clean execution, a real `ZeroDivisionError`, and timeout
termination.

### 6. Future nodes were not part of step boundaries

Date Logic Step 4 initially implemented the `list` command, which belonged to
Logic Core. Lazy step generation now receives every incomplete future node as an
authoritative out-of-scope boundary. After regeneration, Step 4 created only an
isolated `test_date_logic.py` verification.

### 7. Completion memory sounded unfinished and omitted tests

The first final PROJECT.md omitted both test files and claimed final refinement
was still required. Completion inspection now knows the node was just completed,
must mention relevant tests, and includes a bounded workspace inventory. The
refreshed document reports the application complete and ready for use.

## Journey: expectation versus actual

### Node 1 — Data Schema

| Step | Expectation recorded before opening | Actual result |
|---|---|---|
| 1. Define habit structure | Define one habit's fields in `habits.py`; no persistence or commands. | Initially invented a draft filename. After session-wide correction, defined `habit_schema` in `habits.py` only. |
| 2. Root schema | Convert one object into a multi-habit container; no I/O. | Replaced it with `habits_data`, keyed by habit name. |
| 3. Validation | Verify the schema without implementing later features. | Printed and ran the dictionary only. |

Result: **pass after filename correction**. No later-node work was implemented.

### Node 2 — File I/O

| Step | Expectation recorded before opening | Actual result |
|---|---|---|
| 1. Storage setup | Add `json` and `HABITS_FILE`; no load/save bodies. | Exactly added the import and constant. |
| 2. Serialization | Implement only `save_habits()`. | Added `save_habits(data)` and did not call it yet. |
| 3. Deserialization | Implement only `load_habits()` with missing-file handling. | Added `load_habits()` returning `{}` when absent. |
| 4. I/O integration | Connect load/save without CLI or streak behavior. | Loaded at startup, saved at shutdown, and produced valid `{}` JSON across runs. |

Result: **pass**. Each function retained real unfinished work for the next step.

### Node 3 — CLI Parser

| Step | Expectation recorded before opening | Actual result |
|---|---|---|
| 1. Parser structure | Add `argparse`, parser, and parse activation only. | Initial detail omitted `parse_args()` while claiming `--help` worked. A detail-only correction regenerated valid code. |
| 2. Subcommands | Register positional `add`, `done`, and `list` arguments; no handlers. | Added only parser definitions and temporary command confirmation. |
| 3. Dispatch | Move parsing into `main()` and create placeholder branches. | Preserved every earlier function and added placeholder dispatch only. |

Correction interaction:

> This step's title and goal are fine, but the detailed code is wrong: it says
> python habits.py --help will show help, yet it never calls
> parser.parse_args(). Please regenerate this step detail so its code and
> expected result actually match. Do not inspect or edit files.

Tool activity: `regenerate_step_with_notes` only. Result: **pass**.

### Node 4 — Date Logic

| Step | Expectation recorded before opening | Actual result |
|---|---|---|
| 1. Today helper | Add date import and `get_today_str()` only. | Added exactly that helper. |
| 2. Record today | Add same-day completion recording without full streak calculation. | Added date append and duplicate-day protection. |
| 3. Date difference | Add a separate elapsed-days helper. | Added `get_days_since_last_completion()`. |
| 4. Date verification | Verify date logic without consuming Logic Core. | Initially implemented `list`; after the future-node fix and correction, created isolated dynamic date tests only. |

Result: **pass after future-node boundary fix**.

### Node 5 — Logic Core

| Step | Expectation recorded before opening | Actual result |
|---|---|---|
| 1. Add behavior | Implement add and duplicate protection only. | Added schema-correct creation and persistence. |
| 2. List behavior | Implement list/empty states without consecutive streak work. | Added last-completion status while preserving add/done. |
| 3. Core verification | Test lifecycle without adding a feature. | Initially used invalid `--name` flags. Detail-only correction changed commands to positional arguments and the full lifecycle passed. |

Correction interaction:

> This verification step uses --name, but our real argparse code defines name
> as a positional argument. The correct commands are python habits.py add
> Reading and python habits.py done Reading. Keep the step goal, regenerate only
> its detail with the real commands, and do not inspect or edit files.

Tool activity: `regenerate_step_with_notes` only. Result: **pass**.

### Node 6 — Streak Engine

| Step | Expectation recorded before opening | Actual result |
|---|---|---|
| 1. Algorithm prototype | Define and test consecutive-day logic without changing list. | Built a standalone streak test prototype. |
| 2. Production integration | Move the tested function into `habits.py`, preserve old code, then display it. | Initial detail assumed the test-only function was available. Correction explicitly added it to production before updating list. |
| 3. Edge cases | Test empty, today, yesterday, multi-day, and gap-reset states. | Dynamic production tests passed all five cases. |

Correction interaction:

> This step is incomplete: calculate_streak currently exists only in
> test_streak_engine.py, not habits.py. Regenerate this detail so it adds the
> tested function to habits.py before list calls it. Do not import production
> logic from a test file, and preserve all existing habits.py functions.

Tool activity: `regenerate_step_with_notes` only. Result: **pass**.

### Node 7 — Integration

| Step | Expectation recorded before opening | Actual result |
|---|---|---|
| 1. Output edge cases | Make one focused output polish without rewriting. | Added today/yesterday/older status handling. |
| 2. Argument robustness | Handle a different integration edge case. | Prevented `done` from silently creating a misspelled habit. |
| 3. Final verification | Exercise the full application without a new feature. | Verified broken streak, gap-to-today reset, add, duplicate add, done, same-day protection, list, tests, syntax, and JSON. |

Result: **pass**.

## Python crash interaction

Deliberate bug:

```python
print(load_habits()["missing"])
```

Learner prompt:

> My code crashes when I run python habits.py. Please run my real file exactly
> once, quote the exact traceback and line, then explain the smallest fix for me
> as a 12-year-old.

Final tool activity:

1. `read_file: habits.py`
2. `run_python: habits.py`

No second Python execution occurred. The response included:

```text
Traceback (most recent call last):
  File "<exec>", line 36, in <module>
KeyError: 'missing'
```

The smallest fix, `print(load_habits())`, was correct.

## Final verification output

The completed project passed:

- unknown habit rejection;
- add and duplicate-add protection;
- mark done and same-day duplicate protection;
- JSON save/load across processes;
- empty/current/broken streak cases;
- gap followed by today produces a current streak of 1;
- `test_date_logic.py`;
- `test_streak_engine.py`;
- Python `compileall`;
- `json.tool` validation.

Representative final output:

```text
Error: Habit 'Missing' not found. Use 'add' to create it first.
Added new habit: Meditation
Habit 'Meditation' already exists.
Marked 'Meditation' as done for 2026-07-31.
'Meditation' was already marked done today.
- Meditation: Done today | Current streak: 1 day
All tests passed!
All streak tests passed!
```

## Final memory state

`USER.md`:

```markdown
# User

- Age: 12
```

`PROJECT.md` now states that the application is complete, names `habits.py`,
`habits.json`, `test_date_logic.py`, and `test_streak_engine.py`, and includes a
bounded current workspace inventory.

## Environmental notes

- The first live call needed unsandboxed network approval to reach OpenRouter;
  this was a Codex execution restriction, not a PathForge failure.
- A test-only PGlite database placed inside the OneDrive repository could not
  reopen after process exit. Copying that isolated database to LocalAppData Temp
  restored normal resume behavior. PathForge's default CLI database is already
  outside the repository, so normal users do not follow this test-only layout.

## Overall assessment

The original nine findings are now covered by both deterministic regressions and
this real-model CLI journey. The retest also found and fixed five important
handoff/runtime issues that deterministic models had not exposed: lazy session
invariants, injected-context classification, post-cap convergence, Pyodide
workspace resolution, and future-node boundaries.

The next highest-value step is to turn the exact live interactions in this file
into a replayable semi-automated eval so future prompt/harness changes can detect
these regressions without manually completing all 23 steps.

## Automated replay suite

Implemented after the live journey in:

`artifacts/api-server/src/lib/agent/evals/habittracker-replay.ts`

Run only this replay from the repository root:

```powershell
pnpm run agent:eval-habittracker
```

It is also part of the normal deterministic checkpoint:

```powershell
pnpm run agent:verify
```

The suite replays 12 guarantees using the exact recorded learner prompts,
scripted model decisions, real harness events, and the same production guard
functions used by the API route. It does not call OpenRouter or Docker, so it is
fast, free, and repeatable. It covers correction-tool isolation, invalid argument
recovery, sibling filename propagation, earlier-code preservation, later-work
boundaries, the one-run Python cap, exact traceback grounding, PROJECT/USER memory
separation, one-file graph retrieval, CLI-context classification, and concise
correction responses.

This suite protects known behavioral contracts. It does not prove that a live
model will always choose a good 23-step curriculum, so a smaller live-model smoke
journey remains a release-level check rather than an every-change check.
