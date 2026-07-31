import assert from "node:assert/strict";
import { findOpeningMessage, hydrateStepDetails, parseSlides } from "./slides";

const opening = `[SLIDE:intro]
Welcome
[SLIDE:1]
**Inspect the code**
Find the entry point.
[NOTE: Earlier work created package.json]
[SLIDE:2]
**Run the tests**
Use the existing test command.`;

const slides = parseSlides(opening);
assert.equal(slides.length, 3);
assert.equal(slides[1]?.title, "Inspect the code");
assert.equal(slides[1]?.agentNote, "Earlier work created package.json");
assert.equal(slides[1]?.content, "Find the entry point.");

const messages = [
  { role: "assistant", content: opening },
  {
    role: "assistant",
    content: "[STEP_DETAIL:1]\nDetailed first step\n[/STEP_DETAIL:1]",
  },
];
assert.equal(findOpeningMessage(messages), opening);
assert.equal(hydrateStepDetails(slides, messages)[1]?.detailedContent, "Detailed first step");

process.stdout.write("PathForge CLI parsing checks passed.\n");
