import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgentHarness,
  AllowlistedCommandPolicy,
  ApplyPatchTool,
  DockerSandbox,
  ExactCommandPolicy,
  FileContextProvider,
  InspectProjectTool,
  ListFilesTool,
  OpenRouterModelAdapter,
  PreparePythonDependenciesTool,
  ReadFileTool,
  RunCommandTool,
  RuntimeDetector,
  RuntimePolicy,
  SandboxManager,
  SearchCodeTool,
  ToolRegistry,
  UnsupportedRunCommandTool,
  WorkspaceAccess,
  type AgentContextDocuments,
  type AgentContextProvider,
  type AgentEvent,
  type AgentRuntime,
  type AgentTool,
  type AgentTurnInput,
  type CompletionGateway,
  type CompletionRequest,
  type ModelAdapter,
} from "@workspace/agent-runtime";
import type { LearnerProfile } from "@workspace/db";
import type { LegacyChatContext } from "./legacy-runtime";
import { extractStepCodeCells } from "../aiNodeChat";
import { logger } from "../logger";
import { createPathforgePlanTools } from "./tools/plan-proposal-tools";
import { RunPythonTool } from "./tools/run-python-tool";
import { ProposeEnvironmentTool } from "./tools/propose-environment-tool";
import { RunInEnvironmentTool } from "./tools/run-in-environment-tool";
import { UpdateMemoryTool } from "./tools/update-memory-tool";
import { STEP_WRITER_SOUL, TUTOR_SOUL } from "./agentSouls";

/** Supplies SOUL/USER/PROJECT context to the harness from in-memory strings. */
class InlineContextProvider implements AgentContextProvider {
  constructor(private readonly documents: AgentContextDocuments) {}
  async load(): Promise<AgentContextDocuments> {
    return this.documents;
  }
}

/**
 * Wraps another provider and appends the canonical code cells from the step pages
 * the learner is reading onto the PROJECT doc. Without this the tutor re-derives
 * its own variable/function names and drifts out of sync with the steps on screen.
 */
class StepCodeContextProvider implements AgentContextProvider {
  constructor(
    private readonly inner: AgentContextProvider,
    private readonly stepCode: string,
  ) {}
  async load(input: AgentTurnInput): Promise<AgentContextDocuments> {
    const docs = await this.inner.load(input);
    if (!this.stepCode.trim()) return docs;
    const addendum = `\n\n## Code the steps gave this learner (CANONICAL — this is what is on their screen)\n\`\`\`\n${this.stepCode.trim()}\n\`\`\`\nReuse these EXACT identifiers — variable, function, and file names — whenever you discuss, extend, correct, or debug this code. Never rename them or introduce a parallel version under a different name. If one is genuinely wrong, say so explicitly and call update_step instead of silently answering with a different name.`;
    return { ...docs, project: `${docs.project ?? ""}${addendum}` };
  }
}

const MODEL = "google/gemini-3.1-flash-lite";

/**
 * Condenses one oversized tool result into what it contributed to the task, so a
 * long run on a file-heavy project doesn't carry every full file in context. Only
 * ever applied to results the model has already moved past (see
 * ObservationCompaction) — the newest result stays verbatim.
 */
async function summarizeObservation(input: {
  tool: string;
  arguments: Record<string, unknown>;
  output: unknown;
}): Promise<string> {
  const { openrouter } = await import("@workspace/integrations-openrouter-ai");
  const raw = JSON.stringify(input.output ?? "").slice(0, 24_000);
  const originalChars = JSON.stringify(input.output ?? "").length;
  const response = await openrouter.chat.completions.create({
    model: MODEL,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `A coding tutor ran the tool \`${input.tool}\` with arguments ${JSON.stringify(
          input.arguments,
        )} and got the result below. In at most 4 sentences, state what this result established about the project — what exists, what it does, key names (files, functions, variables) worth remembering, and anything that looked wrong. Facts only, no advice.\n\nRESULT:\n${raw}`,
      },
    ],
  });
  const summary = response.choices[0]?.message?.content ?? "";
  logger.info(
    { tool: input.tool, fromChars: originalChars, toChars: summary.length },
    "compacted an older tool observation",
  );
  return summary;
}

const NO_SANDBOX_MESSAGE =
  "No local project folder is attached to this lesson, so there is nothing to run. Attach a folder to enable running code.";

async function pathIsDirectory(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Builds the command tool for a real local workspace: detect the runtime, and
 * if supported and Docker is ready, run approved commands in an isolated Docker
 * sandbox. Any problem (unsupported project, Docker not running, missing images)
 * degrades gracefully to an explanatory no-op tool so the agent can still read
 * and reason about the project.
 */
async function buildCommandTool(
  workspaceRoot: string,
  workspace: WorkspaceAccess,
): Promise<{ commandTool: AgentTool; sandboxes?: SandboxManager }> {
  try {
    const detection = await new RuntimeDetector({
      workspaceEdits: workspace.stagedEdits(),
    }).detect(workspaceRoot);
    if (detection.status !== "supported") {
      return { commandTool: new UnsupportedRunCommandTool(detection.message) };
    }
    const decision = new RuntimePolicy().evaluate(detection.plan);
    if (!decision.allowed) {
      return { commandTool: new UnsupportedRunCommandTool(decision.reason) };
    }
    const docker = new DockerSandbox({
      runtimePlan: decision.approvedPlan,
      dependencyCacheMetadataPath: join(tmpdir(), "pathforge-agent", "dependency-cache-usage.json"),
    });
    const dockerStatus = await docker.preflight();
    if (!dockerStatus.ready) {
      return { commandTool: new UnsupportedRunCommandTool(dockerStatus.message) };
    }
    const sandboxes = new SandboxManager(docker, workspaceRoot, () => workspace.stagedEdits());
    const commandPlan = decision.approvedPlan.plan.commands;
    const policy =
      commandPlan.kind === "package-scripts"
        ? new AllowlistedCommandPolicy({
            packageManagers: [...commandPlan.packageManagers],
            scripts: [...commandPlan.scripts],
          })
        : new ExactCommandPolicy({
            commands: commandPlan.recipes.map((recipe) => ({
              command: recipe.command,
              arguments: [...recipe.arguments],
            })),
          });
    const commandTool = new RunCommandTool({ policy, sandboxes, timeoutMs: 120_000 });
    return { commandTool, sandboxes };
  } catch (error) {
    return {
      commandTool: new UnsupportedRunCommandTool(
        error instanceof Error ? error.message : "The sandbox is unavailable.",
      ),
    };
  }
}

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
      // Stable location (set by the desktop shell to userData/agent-context) so the
      // tutor's USER.md persists across sessions; falls back to a temp dir in dev.
      const home = process.env.PATHFORGE_AGENT_HOME?.trim() || join(tmpdir(), "pathforge-agent-home");
      await mkdir(home, { recursive: true });
      await Promise.all([
        writeIfMissing(join(home, "SOUL.md"), `${TUTOR_SOUL}\n`),
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
 * `AgentRuntime` backed by the lab's `AgentHarness`. When the lesson has a real
 * local project folder attached (`ctx.workspaceRoot`), the harness operates on
 * it directly — real files plus an isolated Docker sandbox for running commands
 * (with graceful fallback when Docker is unavailable). Otherwise it falls back
 * to materializing the DB code snippets into a disposable temp workspace with no
 * command execution. Selected via `AGENT_RUNTIME=harness`.
 */
export class HarnessAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, AgentHarness>();

  constructor(private readonly deps: HarnessAgentRuntimeDeps) {}

  async *runTurn(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    const ctx = await this.deps.loadContext(input);
    const useRealFolder = await pathIsDirectory(ctx.workspaceRoot);

    const [agentHome, workspaceRoot, model] = await Promise.all([
      ensureAgentHome(),
      useRealFolder ? Promise.resolve(ctx.workspaceRoot as string) : materializeWorkspace(ctx),
      (this.deps.createModel ?? defaultCreateModel)(),
    ]);
    const workspace = new WorkspaceAccess(workspaceRoot);

    const { commandTool, sandboxes } = useRealFolder
      ? await buildCommandTool(workspaceRoot, workspace)
      : { commandTool: new UnsupportedRunCommandTool(NO_SANDBOX_MESSAGE), sandboxes: undefined };

    const harnessTools: AgentTool[] = [
      new InspectProjectTool(workspace),
      new ListFilesTool(workspace),
      new ReadFileTool(workspace),
      new SearchCodeTool(workspace),
      new ApplyPatchTool(workspace, sandboxes),
      new PreparePythonDependenciesTool({ workspace, sandboxes }),
      commandTool,
      // Zero-install Python execution (WASM) — available even without Docker,
      // so the tutor can run/verify common Python regardless of the sandbox.
      new RunPythonTool(workspace),
      // Propose a Docker environment for project types the built-in sandboxes
      // don't cover (recorded/shown only — nothing is built or run).
      new ProposeEnvironmentTool(),
      // Durable memory the tutor maintains: USER.md (learner facts, in the agent
      // home) + PROJECT.md (this project's state, in the folder). SOUL.md stays
      // locked. These are the same docs FileContextProvider feeds back each turn.
      new UpdateMemoryTool(agentHome, workspaceRoot),
      // PathForge learning-plan proposals (update steps, spawn nodes, …). The
      // harness only proposes; the chat route applies them to Postgres.
      ...createPathforgePlanTools(),
    ];
    // Once the learner has approved a custom environment, let the agent build
    // and run the project in it.
    if (useRealFolder && ctx.approvedEnvironment) {
      harnessTools.push(new RunInEnvironmentTool(ctx.approvedEnvironment, workspaceRoot));
    }

    const harness = new AgentHarness({
      model,
      context: new StepCodeContextProvider(
        new FileContextProvider({ agentHome, workspaceRoot }),
        extractStepCodeCells(ctx.history),
      ),
      tools: new ToolRegistry(harnessTools),
      budgets: { maxRunDurationMs: 300_000, maxToolDurationMs: 240_000 },
      // Safety valve for projects with many large files: once a bulky result is
      // no longer the one being reasoned about, keep only what it contributed.
      // Typical turns (a few hundred tokens of tool output) never reach this.
      observationCompaction: {
        maxCharacters: 8_000,
        summarize: summarizeObservation,
      },
    });

    this.active.set(input.runId, harness);
    try {
      yield* harness.runTurn(input);
    } finally {
      this.active.delete(input.runId);
      // Only the disposable materialized workspace is removed; a real local
      // project folder is never touched.
      if (!useRealFolder) {
        await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async cancel(runId: string): Promise<void> {
    await this.active.get(runId)?.cancel(runId);
  }
}

/**
 * Read-only inspection pass for step generation. When a lesson has a real local
 * folder, this runs a harness turn with ONLY the read tools
 * (inspect_project/list_files/read_file/search_code — no write, no run) plus
 * SOUL/USER/PROJECT context, and returns a concise report of the ACTUAL current
 * project state for this node (what exists, what's done, what's missing, which
 * file to change next). The format-reliable step writer then grounds the steps
 * in this report. Returns "" if inspection produced nothing.
 */
export async function inspectProjectState(
  params: {
    node: { id: number; title: string; brief: string };
    project: { title: string; ideaPrompt: string };
    profile: LearnerProfile | null;
    workspaceRoot: string;
  },
  onTool?: (tool: string, detail?: string) => void,
): Promise<string> {
  const { node, project, profile, workspaceRoot } = params;
  const workspace = new WorkspaceAccess(workspaceRoot);
  const model = await defaultCreateModel();

  const soul = STEP_WRITER_SOUL;
  const userDoc = profile
    ? [
        profile.educationLevel ? `Education: ${profile.educationLevel}` : null,
        profile.major ? `Field: ${profile.major}` : null,
        profile.profileSummary || null,
      ]
        .filter(Boolean)
        .join("\n")
    : "No learner profile available.";
  const projectDoc = `${project.title}\n\n${project.ideaPrompt}`;

  const harness = new AgentHarness({
    model,
    context: new InlineContextProvider({ soul, user: userDoc, project: projectDoc }),
    tools: new ToolRegistry([
      new InspectProjectTool(workspace),
      new ListFilesTool(workspace),
      new ReadFileTool(workspace),
      new SearchCodeTool(workspace),
    ]),
    budgets: { maxRunDurationMs: 120_000, maxToolDurationMs: 60_000 },
  });

  const instruction = `Inspect the learner's ACTUAL project for the current learning node "${node.title}"${node.brief ? ` (${node.brief})` : ""}. Use the read-only tools to list files and read the ones relevant to this node.

Then write a CONCISE report (~120 words, prose, no headers) of the CURRENT STATE relevant to this node:
- which files exist and what is already implemented,
- what is missing or incomplete for this node's goal,
- the specific file(s) and function(s) the learner should change next.
Reference the real file names and identifiers. This report will be given to the step writer — do not write learner-facing steps yourself.`;

  let report = "";
  try {
    for await (const event of harness.runTurn({
      runId: randomUUID(),
      workspaceId: "step-inspector",
      preferredLanguage: profile?.preferredLanguage ?? null,
      currentNode: { id: node.id, title: node.title, brief: node.brief || undefined },
      messages: [],
      userMessage: instruction,
    })) {
      if (event.type === "tool_started" && onTool) {
        const args = event.arguments as Record<string, unknown> | undefined;
        const detail =
          typeof args?.path === "string" ? args.path
          : typeof args?.query === "string" ? args.query
          : undefined;
        onTool(event.tool, detail);
      } else if (event.type === "text_delta") {
        report += event.content;
      }
    }
  } catch {
    return "";
  }
  return report.trim();
}
