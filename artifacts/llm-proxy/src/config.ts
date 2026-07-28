/**
 * All limits are server-side; nothing here is ever sent to a client. The
 * OpenRouter key lives only in this process — the app never receives it.
 */
function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

export const config = {
  port: num("PORT", 8080),

  /** Required. The upstream key — the whole reason this service exists. */
  openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() ?? "",
  openRouterBaseUrl:
    process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",

  /**
   * Shipped inside the desktop app, so it is a speed bump (blocks drive-by
   * scanners), NOT a secret. The real protections are the quotas below.
   */
  appKey: process.env.PATHFORGE_APP_KEY?.trim() ?? "",

  /** Only these models may be requested, so nobody can bill you for a big model. */
  allowedModels: (process.env.ALLOWED_MODELS?.trim() || "google/gemini-3.1-flash-lite")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),

  /** Hard ceiling on a single request, independent of what the client asks for. */
  maxTokensPerRequest: num("MAX_TOKENS_PER_REQUEST", 16384),

  limits: {
    perDeviceDailyRequests: num("DEVICE_DAILY_REQUESTS", 60),
    perDeviceDailyTokens: num("DEVICE_DAILY_TOKENS", 200_000),
    perIpDailyRequests: num("IP_DAILY_REQUESTS", 200),
    perIpDailyTokens: num("IP_DAILY_TOKENS", 600_000),
    /** The one that actually bounds your bill, whatever an attacker does. */
    globalDailyTokens: num("GLOBAL_DAILY_TOKENS", 5_000_000),
  },

  /** Redis is required for correct quotas across more than one replica. */
  redisUrl: process.env.REDIS_URL?.trim() ?? "",
} as const;

export function assertConfig(): void {
  if (!config.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY must be set — this service exists to hold it.");
  }
}
