/**
 * Hermetic verification that the harness runtime operates on a REAL local folder
 * when one is attached: it reads the actual file on disk (not a materialized DB
 * snippet), and it never deletes the real folder. No network (fake model), no
 * Docker (a folder with no manifest degrades the command tool gracefully).
 *
 *   pnpm --filter @workspace/api-server run agent:verify-real-folder
 */
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentDecision,
  AgentEvent,
  AgentTurnInput,
  ModelAdapter,
  ModelTurnContext,
} from "@workspace/agent-runtime";
import { HarnessAgentRuntime } from "./harness-runtime";
import type { LegacyChatContext } from "./legacy-runtime";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

const REAL_CONTENT = "REAL FILE CONTENT 42";

/** Reads hello.txt on the first decision, then finalizes. */
class ReadFileFakeModel implements ModelAdapter {
  private called = false;
  async decide(_context: ModelTurnContext): Promise<AgentDecision> {
    if (!this.called) {
      this.called = true;
      return { type: "tool_call", call: { id: "c1", name: "read_file", arguments: { path: "hello.txt" } } };
    }
    return { type: "final", response: "I read the file.", proposedActions: [{ type: "none", reason: "done" }] };
  }
}

async function main(): Promise<void> {
  console.log("HarnessAgentRuntime real-folder verification\n");

  const realDir = await mkdtemp(join(tmpdir(), "pathforge-realfolder-"));
  await writeFile(join(realDir, "hello.txt"), REAL_CONTENT, "utf8");

  const loadContext = async (): Promise<LegacyChatContext> =>
    ({
      node: { id: 1, title: "Intro", brief: "" },
      project: { title: "Demo", ideaPrompt: "Build a todo app" },
      profile: null,
      history: [],
      mapCtx: { allNodes: [], allEdges: [] },
      recentConcerns: [],
      codeFiles: [], // deliberately empty — the real file must come from disk
      completedStepIndices: [],
      workspaceRoot: realDir,
    }) as unknown as LegacyChatContext;

  const runtime = new HarnessAgentRuntime({ loadContext, createModel: () => new ReadFileFakeModel() });
  const input: AgentTurnInput = {
    runId: "realfolder-1", workspaceId: "ws-1", preferredLanguage: null,
    currentNode: { id: 1, title: "Intro" }, messages: [], userMessage: "what's in hello.txt?",
  };

  const events: AgentEvent[] = [];
  for await (const event of runtime.runTurn(input)) events.push(event);

  const readEvent = events.find(
    (e): e is Extract<AgentEvent, { type: "tool_completed" }> =>
      e.type === "tool_completed" && e.tool === "read_file",
  );
  check(
    "harness read the REAL file from disk",
    !!readEvent && String((readEvent.output as { content?: string }).content).includes(REAL_CONTENT),
    JSON.stringify(readEvent?.output),
  );
  check("turn reaches completed", events.some((e) => e.type === "completed"));

  const stillThere = await stat(realDir).then((s) => s.isDirectory()).catch(() => false);
  check("the real folder was NOT deleted", stillThere);

  await rm(realDir, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
