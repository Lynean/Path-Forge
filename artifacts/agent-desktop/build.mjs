import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(packageRoot, "dist");

await rm(outputDirectory, { recursive: true, force: true });

await Promise.all([
  esbuild({
    absWorkingDir: packageRoot,
    entryPoints: ["./src/main/main.ts"],
    outfile: resolve(outputDirectory, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
  }),
  esbuild({
    absWorkingDir: packageRoot,
    entryPoints: ["./src/preload/preload.ts"],
    outfile: resolve(outputDirectory, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
  }),
  viteBuild({
    root: resolve(packageRoot, "src/renderer"),
    base: "./",
    plugins: [react()],
    build: {
      outDir: resolve(outputDirectory, "renderer"),
      emptyOutDir: false,
    },
  }),
]);
