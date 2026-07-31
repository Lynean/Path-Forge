import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { graphCode } from "./code-graph";

function usage(): never {
  throw new Error(
    "Usage: pnpm --filter @workspace/agent-runtime run graph:code -- <input-file> <output.json> [--tab-width N] [--max-nodes N]",
  );
}

const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--") arguments_.shift();
const input = arguments_[0];
const output = arguments_[1];
if (!input || !output) usage();

let tabWidth = 4;
let maxNodes = 2_000;
for (let index = 2; index < arguments_.length; index += 2) {
  const flag = arguments_[index];
  const value = Number(arguments_[index + 1]);
  if (!Number.isInteger(value)) usage();
  if (flag === "--tab-width") {
    tabWidth = value;
  } else if (flag === "--max-nodes") {
    maxNodes = value;
  } else {
    usage();
  }
}

const invocationDirectory = process.env["INIT_CWD"] ?? process.cwd();
const inputPath = resolve(invocationDirectory, input);
const outputPath = resolve(invocationDirectory, output);
const source = await readFile(inputPath, "utf8");
const graph = graphCode(source, {
  path: inputPath,
  tabWidth,
  maxNodes,
});
await writeFile(outputPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
process.stdout.write(
  `Wrote ${graph.nodes.length} nodes and ${graph.rootIds.length} roots to ${outputPath}\n`,
);
