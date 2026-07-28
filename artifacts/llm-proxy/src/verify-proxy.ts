/**
 * Verifies the proxy without touching OpenRouter: a fake upstream stands in, so
 * the quota gates, model allowlist, header auth, streaming passthrough and usage
 * metering are all exercised deterministically.
 *
 *   pnpm --filter @workspace/llm-proxy run verify
 */
export {}; // makes this a module so top-level await is allowed

process.env.OPENROUTER_API_KEY ||= "test-key";
process.env.DEVICE_DAILY_REQUESTS ||= "3";
process.env.DEVICE_DAILY_TOKENS ||= "500";
process.env.GLOBAL_DAILY_TOKENS ||= "10000";

const { createApp } = await import("./app");
const { MemoryCounterStore, QuotaService } = await import("./quota");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

// ── fake upstream ────────────────────────────────────────────────────────────
let lastUpstreamAuth = "";
let lastUpstreamBody: any = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  lastUpstreamAuth = init?.headers?.Authorization ?? "";
  lastUpstreamBody = JSON.parse(init?.body ?? "{}");
  if (lastUpstreamBody.stream) {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 120 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 200 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

// ── boot on an ephemeral port ────────────────────────────────────────────────
const app = createApp(new QuotaService(new MemoryCounterStore()));
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;

const call = (body: unknown, headers: Record<string, string> = {}) =>
  realFetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-pathforge-device": "device-abcd1234", ...headers },
    body: JSON.stringify(body),
  });

const validBody = { model: "google/gemini-3.1-flash-lite", messages: [{ role: "user", content: "hi" }] };

console.log("llm-proxy verification\n");

// 1. identity required
const noDevice = await realFetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(validBody),
});
check("rejects a request with no device id", noDevice.status === 400, `got ${noDevice.status}`);

// 2. model allowlist
const badModel = await call({ ...validBody, model: "openai/gpt-4o" });
check("rejects a model outside the allowlist", badModel.status === 400, `got ${badModel.status}`);

// 3. happy path + key never exposed
const ok = await call(validBody);
const okJson: any = await ok.json();
check("forwards a valid request", ok.status === 200 && okJson.choices?.[0]?.message?.content === "hi");
check("sends the server key upstream", lastUpstreamAuth === "Bearer test-key", lastUpstreamAuth);
check("never returns the key to the client", !JSON.stringify(okJson).includes("test-key"));
check("clamps max_tokens", lastUpstreamBody.max_tokens <= 16384, String(lastUpstreamBody?.max_tokens));

// 4. streaming passthrough + usage metering
const streamed = await call({ ...validBody, stream: true });
const text = await streamed.text();
check("streams SSE through to the client", text.includes('"content":"hel"') && text.includes("[DONE]"));

// 5. token quota trips (200 + 120 already used, limit 500 -> next big call crosses it)
await call(validBody); // +200 => 520 > 500
const overTokens = await call(validBody);
check("blocks once the daily token limit is used", overTokens.status === 429, `got ${overTokens.status}`);
const overJson: any = await overTokens.json();
check("explains which limit tripped", overJson.reason === "device_tokens", JSON.stringify(overJson));
check("tells the user how to continue", String(overJson.hint).includes("your own OpenRouter API key"));
check("sets Retry-After", Boolean(overTokens.headers.get("retry-after")));

// 6. a different device is unaffected
const otherDevice = await call(validBody, { "x-pathforge-device": "device-zzzz9999" });
check("quota is per device", otherDevice.status === 200, `got ${otherDevice.status}`);

// 7. quota endpoint
const snap: any = await (
  await realFetch(`${base}/v1/quota`, { headers: { "x-pathforge-device": "device-abcd1234" } })
).json();
check("reports remaining quota", typeof snap.deviceRequestsRemaining === "number" && typeof snap.resetsAt === "string");

server.close();
console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
