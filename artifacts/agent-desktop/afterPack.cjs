// electron-builder hard-ignores any `node_modules` dir inside extraResources, so
// the backend's external runtime packages (pyodide, @electric-sql/pglite, ws)
// get stripped from resources/backend. Copy them back in after packaging — they
// live outside app.asar (plain files), so their WASM/data assets load normally.
const { cp } = require("node:fs/promises");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const src = path.resolve(__dirname, "pkg", "backend", "node_modules");
  const dest = path.join(context.appOutDir, "resources", "backend", "node_modules");
  await cp(src, dest, { recursive: true, dereference: true });
  console.log(`afterPack: restored backend node_modules -> ${dest}`);
};
