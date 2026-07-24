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

function resolveClient(): OpenAI {
  const key = getOpenRouterApiKey();
  if (!key) {
    throw new Error("OpenRouter API key is not configured. Add your key in Settings.");
  }
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
