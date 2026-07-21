import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/calculator.js";

test("adds two numbers", () => {
  assert.equal(add(20, 22), 42);
});

