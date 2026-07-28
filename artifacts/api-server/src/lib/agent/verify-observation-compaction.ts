/**
 * Verifies observation compaction: a bulky tool result is condensed ONLY once it
 * is no longer the newest, small results are never touched, and the newest result
 * always stays verbatim (so exact identifiers/tracebacks survive).
 *
 *   pnpm --filter @workspace/api-server run agent:verify-observation-compaction
 */
import { z } from "zod/v4";
import {
  AgentHarness,
  ToolRegistry,
  type AgentDecision,
  type AgentTool,
  type ModelAdapter,
  type ModelTurnContext,
  type ToolObservation,
} from "@workspace/agent-runtime";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

const BIG = "x".repeat(20_000);
const SMALL = "def add(a, b):\n    return a + b";

class FakeReadTool implements AgentTool {
  readonly name = "read_file";
  readonly description = "read";
  readonly inputSchema = z.object({ path: z.string() }).strict();
  async execute(args: Record<string, unknown>): Promise<unknown> {
    return String(args["path"]).startsWith("big") ? BIG : SMALL;
  }
}

/** Drives three tool calls, then answers — so two observations become "older". */
class ScriptedModel implements ModelAdapter {
  observed: ToolObservation[] = [];
  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    this.observed = context.observations;
    const call = (id: string, path: string): AgentDecision => ({
      type: "tool_call",
      call: { id, name: "read_file", arguments: { path } },
    });
    if (context.turn === 1) return call("1", "big.py");
    if (context.turn === 2) return call("2", "small.py");
    if (context.turn === 3) return call("3", "big2.py");
    return { type: "final", response: "done", proposedActions: [] };
  }
}

async function main(): Promise<void> {
  console.log("observation compaction verification\n");

  let summarizeCalls = 0;
  const model = new ScriptedModel();
  const harness = new AgentHarness({
    model,
    tools: new ToolRegistry([new FakeReadTool()]),
    observationCompaction: {
      maxCharacters: 8_000,
      summarize: async ({ tool }) => {
        summarizeCalls += 1;
        return `Summary of ${tool}: the file defines the project entry point.`;
      },
    },
  });

  for await (const _event of harness.runTurn({
    runId: "compaction-test",
    workspaceId: "w",
    preferredLanguage: null,
    currentNode: { id: 1, title: "Test" },
    messages: [],
    userMessage: "check my files",
  })) {
    // drain
  }

  const obs = model.observed;
  const serialized = obs.map((o) => JSON.stringify(o.output ?? ""));
  const isCompacted = (s: string): boolean => s.includes("compactedResult");

  check("all three tool results are present", obs.length === 3, `got ${obs.length}`);
  check("the oldest bulky result was compacted", isCompacted(serialized[0] ?? ""), serialized[0]?.slice(0, 120));
  check("the newest result stayed verbatim", !isCompacted(serialized[2] ?? "") && (serialized[2]?.length ?? 0) > 8_000,
    `len=${serialized[2]?.length}`);
  check("the small result was left untouched", (serialized[1] ?? "").includes("def add"), serialized[1]?.slice(0, 80));
  check("summarize ran once (not per turn)", summarizeCalls === 1, `calls=${summarizeCalls}`);

  const totalChars = serialized.reduce((s, x) => s + x.length, 0);
  console.log(`\n  context chars: ${totalChars} (uncompacted would be ~${20_000 * 2 + SMALL.length})`);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
