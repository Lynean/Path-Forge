# Test Project — CLI Habit Tracker

A project brief for manually testing the PathForge agents end to end.
Point the app at a **fresh empty folder** (not `demo/` — that already holds the
Snake game and will skew the planner).

## Project name

**Habit Tracker (command line)**

## Description

Paste this into "New Project":

> A command-line habit tracker in Python. I can add habits, mark them done for
> today, and see how many days in a row I've kept each one. It saves everything
> to a file so my streaks are still there the next time I run it.

## Why this project

It is deliberately chosen to exercise the parts that changed most recently:

| It has… | …which tests |
|---|---|
| Real setup work (folder, file, maybe a venv) | steps no longer repeat setup |
| A natural build order (create file → define function → fill in logic) | per-step scoping (a "define" step must not implement) |
| Lots of named things (`habits`, `load_habits()`, `habits.json`, `streak`) | tutor reuses the step's exact identifiers |
| Pure Python, no graphics | the tutor can actually **run** it (WASM), unlike Snake |
| File persistence | a real, debuggable failure mode to ask about |

## Scope

**In scope — a finished project looks like:**

- Add a habit, list all habits.
- Mark a habit done for today.
- Streak count per habit (consecutive days).
- Saves to and loads from a JSON file in the project folder.
- Runs from the terminal: `python habits.py`.

**Out of scope — say no if the agent proposes these:**

- Any GUI, web page, or web framework.
- A database (SQLite/Postgres) — a JSON file is the point.
- Login, multi-user, or syncing.
- Packaging, publishing, or CI.

Roughly 5–8 nodes. If the map comes back much larger, that is itself a finding
worth reporting.

---

# Test cases

Work through the project normally and watch for these. For anything that fails,
note **which node/step, what you asked, and what it answered** — that is what
makes a report actionable.

### 1. Setup is not repeated
Do node 1's steps, then open nodes 2 and 3.
- ✅ Later steps build on the folder/file that already exists.
- ❌ Any step tells you to create the project folder or the main file again.

### 2. Steps stay in their lane
Find a node where one step defines a function and the next fills in its logic.
- ✅ The "define" step stops at the signature or a placeholder body.
- ❌ It writes the whole implementation, leaving the next step with nothing.

### 3. Tutor matches the step's code — *the sharpest test*
Note an exact name a step gave you (e.g. `habits.json`, `load_habits`). Then ask
the tutor: *"explain that function again"* or *"why isn't my file saving?"*
- ✅ It uses **your exact names**.
- ❌ It invents `data.json`, `read_habits()`, or similar.

### 4. The tutor actually runs your code
Introduce a real bug on purpose (e.g. index an empty list) and ask *"why does
this crash?"*
- ✅ It calls `run_python`, quotes the **real traceback**, and an amber tool note
  appears. **Reload the page — the tool note should still be there.**
- ❌ It guesses without running, or the note vanishes on reload.

### 5. Memory is maintained per node
After completing a node, check:
- `AppData\Roaming\PathForge\agent-context\USER.md` → should describe **you** as
  a learner (level, pace, preferences), not this project.
- `<your project folder>\PROJECT.md` → should describe the **project's** current
  state (files, functions, what's next).
- ❌ Missing, empty, or full of transient chat.

### 6. Long answers recover instead of dead-ending
Ask something huge: *"explain every line of my code in extreme detail with
examples."*
- ✅ A full answer, or a brief flicker then a clean restart.
- ❌ A dead-end "AI response was cut off — please try again."

### 7. Sharing round-trips
Export the project (download icon on its card), delete it, then Import the
`.pforge` file.
- ✅ The map returns with its dependencies intact and the first node available.
- ❌ Anything missing or the order scrambled.

### 8. Dashboard progress is real
- ✅ The card's percentage tracks completed nodes.
- ❌ It shows `--%` or stays at 0 after completing a node.

---

## Expected, not bugs

- **No Docker** → you get WASM Python only. "reading only · install Docker to
  run" is the designed fallback.
- **`pygame`/graphics won't run** in the sandbox — irrelevant here, which is
  part of why this project was chosen.
- **The free tier is off** unless a proxy URL was baked into your build; without
  your own key you'll be asked for one.
