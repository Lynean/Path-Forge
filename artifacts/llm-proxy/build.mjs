import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(root, "dist");
await rm(distDir, { recursive: true, force: true });

await esbuild({
  entryPoints: [path.resolve(root, "src/index.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: distDir,
  outExtension: { ".js": ".mjs" },
  sourcemap: "linked",
  logLevel: "info",
  // Optional at runtime — only loaded when REDIS_URL is set.
  external: ["ioredis"],
  banner: {
    js: `import { createRequire as __cr } from 'node:module';
globalThis.require = __cr(import.meta.url);`,
  },
});
