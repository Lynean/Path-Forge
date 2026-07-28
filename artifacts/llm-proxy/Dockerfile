# Build the bundle in the monorepo, then ship only the bundle on a slim runtime.
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
# Manifests first so dependency install caches independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/llm-proxy/package.json artifacts/llm-proxy/
RUN pnpm install --frozen-lockfile --filter @workspace/llm-proxy...
COPY artifacts/llm-proxy artifacts/llm-proxy
RUN pnpm --filter @workspace/llm-proxy run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Optional: only used when REDIS_URL is set (multi-replica quotas).
RUN npm install --no-save ioredis@5 && npm cache clean --force
COPY --from=build /repo/artifacts/llm-proxy/dist ./dist
# Never run as root.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
