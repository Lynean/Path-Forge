import OpenAI from "openai";

// The key can come from the environment (dev / server-passed) OR be set at
// runtime (BYO: the user's own key, entered in the app and pushed to the local
// backend). A runtime key takes precedence. We intentionally do NOT read/throw
// at import time so the backend can boot with no key configured yet.
let runtimeApiKey: string | null = null;
let cached: { key: string; client: OpenAI } | null = null;

/** Set (or clear, with null) the runtime OpenRouter key. Rebuilds the client lazily. */
export function setOpenRouterApiKey(key: string | null): void {
  const trimmed = key?.trim() || null;
  runtimeApiKey = trimmed;
  cached = null;
}

/** The effective key: runtime override first, then the environment. */
export function getOpenRouterApiKey(): string | null {
  return runtimeApiKey ?? (process.env.OPENROUTER_API_KEY?.trim() || null);
}

/** Whether a usable key is currently configured (never exposes the key itself). */
export function isOpenRouterConfigured(): boolean {
  return getOpenRouterApiKey() !== null;
}

/**
 * Free-tier fallback: when the user has no key of their own, calls are routed to
 * the PathForge proxy, which holds the project's key and enforces daily quotas.
 * Configured by the host (the desktop shell) — absent in plain cloud deploys.
 */
export interface FreeTierConfig {
  proxyUrl: string;
  deviceId: string;
  appKey?: string;
}

export function getFreeTierConfig(): FreeTierConfig | null {
  const proxyUrl = process.env.PATHFORGE_PROXY_URL?.trim();
  const deviceId = process.env.PATHFORGE_DEVICE_ID?.trim();
  if (!proxyUrl || !deviceId) return null;
  return { proxyUrl: proxyUrl.replace(/\/+$/, ""), deviceId, appKey: process.env.PATHFORGE_APP_KEY?.trim() };
}

/** How AI calls are being paid for right now — surfaced in Settings. */
export type LlmMode = "byo" | "free" | "none";

export function getLlmMode(): LlmMode {
  if (getOpenRouterApiKey()) return "byo";
  return getFreeTierConfig() ? "free" : "none";
}

function resolveClient(): OpenAI {
  const key = getOpenRouterApiKey();
  if (key) {
    if (!cached || cached.key !== key) {
      cached = {
        key,
        client: new OpenAI({
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: key,
          timeout: 120_000,
          maxRetries: 2,
        }),
      };
    }
    return cached.client;
  }

  // No key of their own — fall back to the metered free tier when it's configured.
  const free = getFreeTierConfig();
  if (free) {
    const cacheKey = `free:${free.proxyUrl}:${free.deviceId}`;
    if (!cached || cached.key !== cacheKey) {
      cached = {
        key: cacheKey,
        client: new OpenAI({
          baseURL: `${free.proxyUrl}/v1`,
          // The proxy authenticates by headers; it supplies the real key upstream.
          apiKey: free.appKey || "pathforge-free-tier",
          timeout: 120_000,
          maxRetries: 2,
          defaultHeaders: {
            "x-pathforge-device": free.deviceId,
            ...(free.appKey ? { "x-pathforge-app-key": free.appKey } : {}),
          },
        }),
      };
    }
    return cached.client;
  }

  throw new Error("OpenRouter API key is not configured. Add your key in Settings.");
}

// Lazy proxy: the real OpenAI client is built on first property access using the
// current key, so every existing `openrouter.chat.completions.create(...)` call
// site is unchanged, the backend boots with no key, and a key set later (BYO)
// takes effect immediately. A call with no key throws the clear message above.
export const openrouter: OpenAI = new Proxy({} as OpenAI, {
  get(_target, prop, receiver) {
    const client = resolveClient();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
