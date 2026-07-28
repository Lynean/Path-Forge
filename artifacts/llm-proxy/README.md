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

Three layers, all server-side:

1. **Per device** — `DEVICE_DAILY_REQUESTS` / `DEVICE_DAILY_TOKENS`.
2. **Per IP** — `IP_DAILY_REQUESTS` / `IP_DAILY_TOKENS`, so one person can't
   just reinstall for a fresh device id.
3. **Global** — `GLOBAL_DAILY_TOKENS`. This is the one that truly bounds your
   bill: once the day's total is spent, the service returns 429 to everyone.

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
