import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgentHarness,
  ApplyPatchTool,
  FileContextProvider,
  InspectProjectTool,
  ListFilesTool,
  OpenRouterModelAdapter,
  PreparePythonDependenciesTool,
  ReadFileTool,
  SearchCodeTool,
  ToolRegistry,
  UnsupportedRunCommandTool,
  WorkspaceAccess,
  type AgentEvent,
  type AgentRuntime,
  type AgentTurnInput,
  type CompletionGateway,
  type CompletionRequest,
  type ModelAdapter,
} from "@workspace/agent-runtime";
import type { LegacyChatContext } from "./legacy-runtime";

const MODEL = "google/gemini-3.1-flash-lite";
const NO_SANDBOX_MESSAGE =
  "Command execution is unavailable in the API server; the sandboxed workspace agent runs on dedicated infrastructure (a later phase).";

export interface HarnessAgentRuntimeDeps {
  /** Same context loader as the legacy runtime (DB reads in the route). */
  loadContext: (input: AgentTurnInput) => Promise<LegacyChatContext>;
  /** Injectable for hermetic tests; defaults to the OpenRouter-backed model. */
  createModel?: () => ModelAdapter | Promise<ModelAdapter>;
}

/**
 * Builds a `CompletionGateway` over an OpenAI-compatible client (the shared
 * OpenRouter client). Adapted from the agent-desktop lab's gateway; the client
 * is typed loosely to avoid a direct `openai` dependency in the API server.
 */
function gatewayFromClient(client: any): CompletionGateway {
  const messagesFor = (request: CompletionRequest): unknown[] =>
    request.messages.map((message) => {
      if (message.role === "tool") {
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      }
      if (message.role === "assistant" && "toolCalls" in message) {
        return {
          role: "assistant",
          content: message.content,
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function" as const,
            function: toolCall.function,
          })),
        };
      }
      return { role: message.role, content: message.content };
    });

  return {
    async complete(request) {
      const response = await client.chat.completions.create(
        {
          model: request.model,
          messages: messagesFor(request),
          tools: request.tools,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          parallel_tool_calls: request.parallelToolCalls,
        },
        { signal: request.signal },
      );
      const message = response.choices[0]?.message;
      if (!message) throw new Error("OpenRouter returned no completion choice");
      return {
        content: typeof message.content === "string" ? message.content : null,
        toolCalls: (message.tool_calls ?? []).flatMap((toolCall: any) =>
          toolCall.type === "function"
            ? [{ id: toolCall.id, name: toolCall.function.name, arguments: toolCall.function.arguments }]
            : [],
        ),
      };
    },
    async *stream(request) {
      const stream = await client.chat.completions.create(
        {
          model: request.model,
          messages: messagesFor(request),
          tools: request.tools,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          parallel_tool_calls: request.parallelToolCalls,
          stream: true,
        },
        { signal: request.signal },
      );
      const contentParts: string[] = [];
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      let finishReason: string | null = null;
      for await (const chunk of stream as any) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const content = choice.delta?.content;
        if (content) {
          contentParts.push(content);
          yield { type: "text_delta", content };
        }
        for (const toolCall of choice.delta?.tool_calls ?? []) {
          const current = toolCalls.get(toolCall.index) ?? {
            id: toolCall.id ?? `tool-call-${toolCall.index}`,
            name: "",
            arguments: "",
          };
          if (toolCall.id) current.id = toolCall.id;
          if (toolCall.function?.name) current.name += toolCall.function.name;
          if (toolCall.function?.arguments) current.arguments += toolCall.function.arguments;
          toolCalls.set(toolCall.index, current);
        }
      }
      if (finishReason && finishReason !== "stop" && finishReason !== "tool_calls") {
        throw new Error(`OpenRouter stream ended unexpectedly (${finishReason})`);
      }
      yield {
        type: "completed",
        response: { content: contentParts.join("") || null, toolCalls: [...toolCalls.values()] },
      };
    },
  };
}

async function defaultCreateModel(): Promise<ModelAdapter> {
  // Lazy import: the shared client throws at module load if OPENROUTER_API_KEY
  // is unset, so importing it eagerly would break hermetic tests.
  const { openrouter } = await import("@workspace/integrations-openrouter-ai");
  return new OpenRouterModelAdapter({
    gateway: gatewayFromClient(openrouter),
    model: MODEL,
    maxTokens: 16384,
  });
}

let agentHomePromise: Promise<string> | null = null;
async function ensureAgentHome(): Promise<string> {
  if (!agentHomePromise) {
    agentHomePromise = (async () => {
      const home = join(tmpdir(), "pathforge-agent-home");
      await mkdir(home, { recursive: true });
      await Promise.all([
        writeIfMissing(
          join(home, "SOUL.md"),
          "# PathForge Agent\n\nInspect evidence before making claims. Teach in small, understandable steps.\n",
        ),
        writeIfMissing(
          join(home, "USER.md"),
          "# User\n\nAdd stable learning preferences here as they become known.\n",
        ),
      ]);
      return home;
    })();
  }
  return agentHomePromise;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Rejects paths that would escape the workspace when writing seed files. */
function isPortableRelative(path: string): boolean {
  if (!path || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  return !segments.some((segment) => segment === "." || segment === "..");
}

async function materializeWorkspace(ctx: LegacyChatContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pathforge-ws-"));
  await writeFile(
    join(dir, "PROJECT.md"),
    `# ${ctx.project.title}\n\n${ctx.project.ideaPrompt}\n`,
    "utf8",
  );
  for (const file of ctx.codeFiles) {
    if (!isPortableRelative(file.filename)) continue;
    const abs = join(dir, file.filename);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content ?? "", "utf8");
  }
  return dir;
}

/**
 * `AgentRuntime` backed by the lab's `AgentHarness`. Each turn materializes the
 * learner's code context into a disposable temp workspace so the harness's file
 * tools work, runs the harness (no Docker — command execution is stubbed), then
 * cleans up. Selected via `AGENT_RUNTIME=harness`; the legacy runtime remains
 * the default fallback.
 */
export class HarnessAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, AgentHarness>();

  constructor(private readonly deps: HarnessAgentRuntimeDeps) {}

  async *runTurn(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    const ctx = await this.deps.loadContext(input);
    const [agentHome, workspaceRoot, model] = await Promise.all([
      ensureAgentHome(),
      materializeWorkspace(ctx),
      (this.deps.createModel ?? defaultCreateModel)(),
    ]);
    const workspace = new WorkspaceAccess(workspaceRoot);
    const harness = new AgentHarness({
      model,
      context: new FileContextProvider({ agentHome, workspaceRoot }),
      tools: new ToolRegistry([
        new InspectProjectTool(workspace),
        new ListFilesTool(workspace),
        new ReadFileTool(workspace),
        new SearchCodeTool(workspace),
        new ApplyPatchTool(workspace, undefined),
        new PreparePythonDependenciesTool({ workspace, sandboxes: undefined }),
        new UnsupportedRunCommandTool(NO_SANDBOX_MESSAGE),
      ]),
      budgets: { maxRunDurationMs: 300_000, maxToolDurationMs: 240_000 },
    });

    this.active.set(input.runId, harness);
    try {
      yield* harness.runTurn(input);
    } finally {
      this.active.delete(input.runId);
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async cancel(runId: string): Promise<void> {
    await this.active.get(runId)?.cancel(runId);
  }
}
