import { config } from "./config";

/**
 * Daily counters keyed by device, IP and a global bucket. Counters are checked
 * BEFORE a request is forwarded and incremented with real usage AFTER, so a
 * burst of concurrent requests can overshoot slightly but never runs away.
 *
 * The store is pluggable because correctness across replicas needs shared
 * state: the in-memory store is fine for a single replica, Redis is required
 * once you scale out (see k8s/README).
 */
export interface CounterStore {
  /** Adds `amount` to a key that expires at the end of the UTC day; returns the new total. */
  increment(key: string, amount: number): Promise<number>;
  get(key: string): Promise<number>;
}

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export class MemoryCounterStore implements CounterStore {
  private readonly counters = new Map<string, number>();
  private day = dayStamp();

  private rollover(): void {
    const today = dayStamp();
    if (today !== this.day) {
      this.counters.clear();
      this.day = today;
    }
  }

  async increment(key: string, amount: number): Promise<number> {
    this.rollover();
    const next = (this.counters.get(key) ?? 0) + amount;
    this.counters.set(key, next);
    return next;
  }

  async get(key: string): Promise<number> {
    this.rollover();
    return this.counters.get(key) ?? 0;
  }
}

/** Redis-backed counters with a TTL to the end of the UTC day. */
export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: {
    incrby(key: string, amount: number): Promise<number>;
    expire(key: string, seconds: number): Promise<unknown>;
    get(key: string): Promise<string | null>;
  }) {}

  private static secondsLeftInDay(): number {
    const now = new Date();
    const endOfDay = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    return Math.max(60, Math.ceil((endOfDay - now.getTime()) / 1000));
  }

  async increment(key: string, amount: number): Promise<number> {
    const total = await this.redis.incrby(key, amount);
    // Only the first write of the day needs the TTL.
    if (total === amount) await this.redis.expire(key, RedisCounterStore.secondsLeftInDay());
    return total;
  }

  async get(key: string): Promise<number> {
    const raw = await this.redis.get(key);
    return raw ? Number(raw) || 0 : 0;
  }
}

export interface QuotaDecision {
  allowed: boolean;
  /** Which limit tripped — surfaced so the app can explain it to the user. */
  reason?:
    | "device_requests"
    | "device_tokens"
    | "device_cost"
    | "ip_requests"
    | "ip_tokens"
    | "global_tokens"
    | "global_cost";
  retryAfterSeconds: number;
}

export interface QuotaSnapshot {
  deviceRequestsRemaining: number;
  deviceTokensRemaining: number;
  deviceCostRemainingUsd: number;
  resetsAt: string;
}

/** What one upstream call actually consumed. */
export interface Usage {
  tokens: number;
  /** Micro-USD (1_000_000 = $1), as reported by the provider when available. */
  costMicros: number;
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000));
}

export class QuotaService {
  constructor(private readonly store: CounterStore) {}

  private keys(deviceId: string, ip: string) {
    const day = dayStamp();
    return {
      deviceRequests: `d:${day}:dev:${deviceId}:req`,
      deviceTokens: `d:${day}:dev:${deviceId}:tok`,
      ipRequests: `d:${day}:ip:${ip}:req`,
      ipTokens: `d:${day}:ip:${ip}:tok`,
      globalTokens: `d:${day}:global:tok`,
      deviceCost: `d:${day}:dev:${deviceId}:cost`,
      globalCost: `d:${day}:global:cost`,
    };
  }

  /** Checked before forwarding. Counts the request immediately so parallel calls can't all slip through. */
  async check(deviceId: string, ip: string): Promise<QuotaDecision> {
    const k = this.keys(deviceId, ip);
    const retryAfterSeconds = secondsUntilUtcMidnight();
    const { limits } = config;

    const [deviceTokens, ipTokens, globalTokens, deviceCost, globalCost] = await Promise.all([
      this.store.get(k.deviceTokens),
      this.store.get(k.ipTokens),
      this.store.get(k.globalTokens),
      this.store.get(k.deviceCost),
      this.store.get(k.globalCost),
    ]);

    // Spend ceilings first — they are the ones that bound the bill.
    if (globalCost >= limits.globalDailyCostMicros) {
      return { allowed: false, reason: "global_cost", retryAfterSeconds };
    }
    if (deviceCost >= limits.perDeviceDailyCostMicros) {
      return { allowed: false, reason: "device_cost", retryAfterSeconds };
    }
    if (globalTokens >= limits.globalDailyTokens) {
      return { allowed: false, reason: "global_tokens", retryAfterSeconds };
    }
    if (deviceTokens >= limits.perDeviceDailyTokens) {
      return { allowed: false, reason: "device_tokens", retryAfterSeconds };
    }
    if (ipTokens >= limits.perIpDailyTokens) {
      return { allowed: false, reason: "ip_tokens", retryAfterSeconds };
    }

    const deviceRequests = await this.store.increment(k.deviceRequests, 1);
    if (deviceRequests > limits.perDeviceDailyRequests) {
      return { allowed: false, reason: "device_requests", retryAfterSeconds };
    }
    const ipRequests = await this.store.increment(k.ipRequests, 1);
    if (ipRequests > limits.perIpDailyRequests) {
      return { allowed: false, reason: "ip_requests", retryAfterSeconds };
    }
    return { allowed: true, retryAfterSeconds };
  }

  /** Recorded after the upstream call, from real usage when the provider reports it. */
  async record(deviceId: string, ip: string, usage: Usage): Promise<void> {
    const k = this.keys(deviceId, ip);
    const writes: Promise<number>[] = [];
    if (usage.tokens > 0) {
      writes.push(
        this.store.increment(k.deviceTokens, usage.tokens),
        this.store.increment(k.ipTokens, usage.tokens),
        this.store.increment(k.globalTokens, usage.tokens),
      );
    }
    if (usage.costMicros > 0) {
      writes.push(
        this.store.increment(k.deviceCost, usage.costMicros),
        this.store.increment(k.globalCost, usage.costMicros),
      );
    }
    await Promise.all(writes);
  }

  async snapshot(deviceId: string, ip: string): Promise<QuotaSnapshot> {
    const k = this.keys(deviceId, ip);
    const [requests, tokens, cost] = await Promise.all([
      this.store.get(k.deviceRequests),
      this.store.get(k.deviceTokens),
      this.store.get(k.deviceCost),
    ]);
    const resetsAt = new Date(Date.now() + secondsUntilUtcMidnight() * 1000).toISOString();
    return {
      deviceRequestsRemaining: Math.max(0, config.limits.perDeviceDailyRequests - requests),
      deviceTokensRemaining: Math.max(0, config.limits.perDeviceDailyTokens - tokens),
      deviceCostRemainingUsd:
        Math.max(0, config.limits.perDeviceDailyCostMicros - cost) / 1_000_000,
      resetsAt,
    };
  }
}
