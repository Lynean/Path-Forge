// Assembles the packaged resource layout for the fully-local app:
//
//   pkg/
//     backend/            api-server/dist/* + a flat node_modules holding the
//                         esbuild-EXTERNAL runtime packages (pyodide, pglite, ws)
//       node_modules/@electric-sql/pglite, pyodide, ws
//     app-public/         the built SPA (VITE_LOCAL_MODE=1)
//     migrations/         lib/db/drizzle
//
// electron-builder ships pkg/{backend,app-public,migrations} as extraResources
// (plain files under resources/, NOT inside app.asar) so the WASM/data assets
// load from real paths. main.ts points the spawned backend at these when packaged.
import { cp, rm, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const pkg = resolve(here, "pkg");
const apiNodeModules = join(repoRoot, "artifacts", "api-server", "node_modules");

// Real dir of a package as linked into api-server's node_modules (deref pnpm
// symlink). Direct realpath avoids `exports`-map issues with require.resolve.
const linkedRealpath = (name) => realpath(join(apiNodeModules, name));

// pyodide's `ws` dependency lives as a sibling symlink under pyodide's pnpm dir;
// fall back to resolving ws's main entry and walking up to its package root.
async function resolveWs(pyodideReal) {
  try {
    return await realpath(join(dirname(pyodideReal), "ws"));
  } catch {
    const req = createRequire(join(pyodideReal, "package.json"));
    let d = dirname(req.resolve("ws"));
    while (basename(d) !== "ws" && d !== dirname(d)) d = dirname(d);
    return await realpath(d);
  }
}

async function copyPkgDir(name, realDir) {
  const dest = join(pkg, "backend", "node_modules", name);
  await mkdir(dirname(dest), { recursive: true });
  await cp(realDir, dest, { recursive: true, dereference: true });
  console.log(`  node_modules/${name}  <-  ${realDir}`);
}

async function main() {
  await rm(pkg, { recursive: true, force: true });
  await mkdir(pkg, { recursive: true });

  // 1) backend bundle
  const backendDist = join(repoRoot, "artifacts", "api-server", "dist");
  await cp(backendDist, join(pkg, "backend"), { recursive: true, dereference: true });
  console.log("backend: copied api-server/dist");

  // 2) external runtime packages (the closure: pglite, pyodide, ws)
  const pglite = await linkedRealpath("@electric-sql/pglite");
  const pyodide = await linkedRealpath("pyodide");
  const ws = await resolveWs(pyodide);
  await copyPkgDir("@electric-sql/pglite", pglite);
  await copyPkgDir("pyodide", pyodide);
  await copyPkgDir("ws", ws);

  // 3) built SPA + migrations
  await cp(join(repoRoot, "artifacts", "app", "dist", "public"), join(pkg, "app-public"), {
    recursive: true,
    dereference: true,
  });
  console.log("app-public: copied app/dist/public");
  await cp(join(repoRoot, "lib", "db", "drizzle"), join(pkg, "migrations"), {
    recursive: true,
    dereference: true,
  });
  console.log("migrations: copied lib/db/drizzle");

  console.log(`\nStaged packaged layout at ${pkg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
