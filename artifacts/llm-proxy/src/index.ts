import { createApp } from "./app";
import { assertConfig, config } from "./config";
import { logger } from "./logger";
import { MemoryCounterStore, QuotaService, RedisCounterStore, type CounterStore } from "./quota";

async function buildStore(): Promise<CounterStore> {
  if (!config.redisUrl) {
    logger.warn(
      "No REDIS_URL set — using in-memory quotas. Correct only for a SINGLE replica; " +
        "scale out and each pod counts separately.",
    );
    return new MemoryCounterStore();
  }
  // Optional dependency, installed only by deployments that scale out. The
  // specifier is held in a variable so this typechecks without ioredis present.
  const specifier = "ioredis";
  const mod = (await import(specifier)) as {
    default: new (url: string) => ConstructorParameters<typeof RedisCounterStore>[0];
  };
  const Redis = mod.default;
  logger.info("Using Redis-backed quotas");
  return new RedisCounterStore(new Redis(config.redisUrl));
}

async function main(): Promise<void> {
  assertConfig();
  const app = createApp(new QuotaService(await buildStore()));
  app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        models: config.allowedModels,
        limits: config.limits,
      },
      "PathForge LLM proxy listening",
    );
  });
}

void main().catch((err) => {
  logger.error({ err }, "failed to start");
  process.exit(1);
});
