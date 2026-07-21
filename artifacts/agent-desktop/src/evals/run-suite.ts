import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../main/conversation-store";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pathforge-conversation-eval-"));

try {
  const store = new ConversationStore(temporaryDirectory);
  const workspaceId = "weather-cli-test";

  assert.deepEqual(await store.load(workspaceId), []);
  await store.save(workspaceId, [
    { role: "user", content: "Why does my test fail?" },
    { role: "assistant", content: "Let us inspect the evidence first." },
  ]);

  const restored = await new ConversationStore(temporaryDirectory).load(workspaceId);
  assert.deepEqual(restored, [
    { role: "user", content: "Why does my test fail?" },
    { role: "assistant", content: "Let us inspect the evidence first." },
  ]);

  await store.clear(workspaceId);
  assert.deepEqual(await store.load(workspaceId), []);
  console.log("PASS workspace conversation saves, restores, and clears");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
