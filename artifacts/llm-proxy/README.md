# PathForge LLM proxy (free tier)

Lets a brand-new user try PathForge **before** they have their own OpenRouter key.
The app calls this service instead of OpenRouter; the service holds your key,
enforces daily quotas, and forwards the request.

Your key lives **only** in this process. It is never sent to the app, never
returned in a response, and is redacted from logs.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible passthrough (streaming + non-streaming, tool calls included) |
| GET | `/v1/quota` | What this device has left today — for the "x requests left" nudge in the UI |
| GET | `/healthz` | Liveness/readiness |

Every request needs an `x-pathforge-device` header (the app's per-install id) and,
if `PATHFORGE_APP_KEY` is set, a matching `x-pathforge-app-key`.

## How the limits work

All server-side, checked before forwarding:

1. **Spend** — `DEVICE_DAILY_COST_USD` (default $0.25) and
   `GLOBAL_DAILY_COST_USD` (default $5). OpenRouter reports the real cost of
   every request, so these are the true bill guards. **`GLOBAL_DAILY_COST_USD`
   is the single most important setting here** — once the day's spend is gone,
   everyone gets a 429.
2. **Tokens** — `DEVICE_DAILY_TOKENS` / `IP_DAILY_TOKENS` /
   `GLOBAL_DAILY_TOKENS`, a coarser backstop if a provider ever omits cost.
3. **Requests** — `DEVICE_DAILY_REQUESTS` / `IP_DAILY_REQUESTS`. The IP limits
   mean one person can't just reinstall for a fresh device id.

Costs are stored as integer micro-USD, so the counters stay exact.

Requests are counted before forwarding; tokens are recorded after, using the
provider's reported usage (falling back to an estimate). Over-limit responses
are `429` with `Retry-After` and a hint telling the user to add their own key.

Two further guards: `ALLOWED_MODELS` (nobody can bill you for an expensive
model) and `MAX_TOKENS_PER_REQUEST` (clamps whatever the client asks for).

### Honest limitations

- The app key ships inside a downloadable app, so treat it as a speed bump, not
  a secret. The quotas — especially the global cap — are the real protection.
- A determined user can reset their device id or change IP. That is expected;
  the global cap is what keeps the worst case bounded.

## Running it

```bash
OPENROUTER_API_KEY=sk-or-v1-... pnpm --filter @workspace/llm-proxy run dev
pnpm --filter @workspace/llm-proxy run verify   # hermetic tests, no network
```

## Kubernetes

```bash
kubectl create secret generic pathforge-llm-proxy \
  --from-literal=openrouter-api-key='sk-or-v1-...' \
  --from-literal=app-key='<random string>'
kubectl apply -f k8s/deployment.yaml
```

**Scaling:** quotas are shared across pods only when `REDIS_URL` is set. Without
Redis each pod counts separately, so keep `replicas: 1` until you wire it up.

## Pointing the desktop app at it

The URL is baked into the app at package time — users need no env vars:

```bash
PATHFORGE_PROXY_URL=https://llm.your-domain.com \
PATHFORGE_APP_KEY=<same value as the k8s secret> \
pnpm --filter @workspace/agent-desktop run package
```

Package without those variables and the build simply has no free tier: users
must add their own key, which is the current shipping behaviour. An env var at
runtime still overrides the baked value, so a local build can point at staging.
