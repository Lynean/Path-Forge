import { resolve } from "node:path";
import { buildProjectGraph, PROJECT_GRAPH_PATH } from "./project-graph";

const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--") arguments_.shift();
const invocationDirectory = process.env["INIT_CWD"] ?? process.cwd();
const workspaceRoot = resolve(invocationDirectory, arguments_[0] ?? ".");
const graph = await buildProjectGraph(workspaceRoot);
process.stdout.write(
  `Wrote ${graph.totals.nodes} nodes from ${graph.totals.files} files to ` +
  `${resolve(workspaceRoot, ...PROJECT_GRAPH_PATH.split("/"))}\n`,
);
