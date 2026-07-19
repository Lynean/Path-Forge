# AIExperience

Real learner conversations with the AI tutor / node map generator, kept here specifically
to find and fix rough edges in the prompts and generation logic — not a general chat log
archive.

## Convention

1. **Drop a raw chat export** into this folder when a session with the tutor went badly —
   confusing, wrong, wasted the learner's time, or the tutor mishandled a self-correction.
   Any filename, but name it for the problem, not the date (e.g. `Issue_ArduinoWSL.txt`).
2. **On request, analyze the file and compact it in place**: replace the raw transcript
   with a distilled write-up covering:
   - **Source**: one-paragraph context (project type, what went wrong, how long it took)
   - **Issues found**: numbered, each with what happened, why it's a problem, and the
     root cause traced to a specific place in the code/prompt (not vague — cite the
     file, function, or prompt section)
   - **Fixes**: numbered, mapped 1:1 to the issues, each naming the exact file/function to
     change and the concrete change — proposed but not auto-applied; confirm before
     implementing, since these are usually shared-prompt changes affecting every learner
   - **Status**: whether the fixes have been applied yet
3. **Once a fix is actually implemented**, update that file's Status line (e.g.
   "STATUS: Fix 1 and 4 applied 2026-07-05, Fix 2/3/5 deferred") so this folder stays an
   accurate record of what's already been tried, instead of the same issue getting
   re-diagnosed from scratch next time.

## Why this exists

The node map generator (`aiNodeMap.ts`) and tutor chat (`aiNodeChat.ts`) prompts are
tuned from reasoning about likely failure modes, not from real transcripts. This folder
closes that loop — real friction becomes a concrete, traceable prompt/logic change
instead of a one-off complaint that's forgotten after the session ends.
