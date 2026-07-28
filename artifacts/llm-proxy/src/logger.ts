import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || "info",
  // Never let a key reach the logs, however it got into an object.
  redact: {
    paths: ["req.headers.authorization", "headers.authorization", "*.apiKey", "*.openRouterApiKey"],
    censor: "[redacted]",
  },
});
