import assert from "node:assert/strict";

process.env.PATHFORGE_LOCAL_DB = ":memory:";
process.env.PATHFORGE_LOCAL_MODE = "1";
process.env.LOG_LEVEL = "fatal";

const { startEmbeddedApi } = await import("./server");
const server = await startEmbeddedApi();
try {
  const response = await fetch(`${server.baseUrl}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
} finally {
  await server.close();
}

process.stdout.write("PathForge CLI embedded API smoke check passed.\n");
