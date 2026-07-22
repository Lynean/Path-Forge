import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { basename, join } from "node:path";
import {
  AgentHarness,
  ApplyPatchTool,
  AllowlistedCommandPolicy,
  DockerSandbox,
  ExactCommandPolicy,
  FakeTutorModelAdapter,
  FileContextProvider,
  InspectProjectTool,
  ListFilesTool,
  OpenRouterModelAdapter,
  PreparePythonDependenciesTool,
  RuntimeDetector,
  RuntimePolicy,
  RunCommandTool,
  SandboxManager,
  ReadFileTool,
  SearchCodeTool,
  ToolRegistry,
  UnsupportedRunCommandTool,
  WorkspaceAccess,
  createNodeRuntimePlan,
  type AgentTool,
  type ApprovedRuntimePlan,
  type AgentEvent,
  type AgentMessage,
  type CompletionGateway,
  type DockerSandboxOptions,
  type ModelAdapter,
} from "@workspace/agent-runtime";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import OpenAI from "openai";
import {
  desktopRunRequestSchema,
  cancelRunRequestSchema,
  type DesktopRunRequest,
  type DesktopRunResult,
  type ConversationState,
  type RuntimeStatus,
  type WorkspaceSelection,
} from "../shared/contracts";
import { ConversationStore } from "./conversation-store";

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let selectedWorkspace: WorkspaceSelection | null = null;
const activeHarnesses = new Map<string, { harness: AgentHarness; runId: string }>();
const stagedWorkspaces = new Map<string, WorkspaceAccess>();
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.1-flash-lite";

function conversationStore(): ConversationStore {
  return new ConversationStore(join(app.getPath("userData"), "conversations"));
}

function baselineNodeRuntimePlan(): ApprovedRuntimePlan {
  return new RuntimePolicy().requireApproved(createNodeRuntimePlan());
}

function desktopDockerSandbox(
  runtimePlan: ApprovedRuntimePlan,
  options: Omit<DockerSandboxOptions, "runtimePlan"> = {},
): DockerSandbox {
  const dependencyCacheRepository =
    process.env["PATHFORGE_AGENT_DEPENDENCY_CACHE_REPOSITORY"]?.trim();
  return new DockerSandbox({
    runtimePlan,
    ...options,
    dependencyCacheMetadataPath: join(app.getPath("userData"), "dependency-cache-usage.json"),
    ...(dependencyCacheRepository ? { dependencyCacheRepository } : {}),
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Rejected IPC request from an unknown renderer");
  }
}

async function writeDefaultIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function ensureAgentHome(): Promise<string> {
  const agentHome = join(app.getPath("userData"), "agent-context");
  await mkdir(agentHome, { recursive: true });
  await Promise.all([
    writeDefaultIfMissing(
      join(agentHome, "SOUL.md"),
      "# PathForge Agent\n\nInspect evidence before making claims. Teach in small, understandable steps.\n",
    ),
    writeDefaultIfMissing(
      join(agentHome, "USER.md"),
      "# User\n\nAdd stable learning preferences here as they become known.\n",
    ),
  ]);
  return agentHome;
}

function parseEnvValue(contents: string, name: string): string | null {
  const line = contents
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${name}=`));
  if (!line) return null;
  const value = line.slice(line.indexOf("=") + 1).trim();
  const unquoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;
  return unquoted || null;
}

async function resolveOpenRouterApiKey(): Promise<string | null> {
  if (process.env["OPENROUTER_API_KEY"]?.trim()) {
    return process.env["OPENROUTER_API_KEY"]!.trim();
  }

  const candidates = [
    join(process.cwd(), ".env"),
    join(app.getAppPath(), "..", "..", ".env"),
  ];
  for (const path of [...new Set(candidates)]) {
    try {
      const value = parseEnvValue(await readFile(path, "utf8"), "OPENROUTER_API_KEY");
      if (value) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

function createOpenRouterGateway(apiKey: string): CompletionGateway {
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: 120_000,
    maxRetries: 2,
  });

  const messagesFor = (
    request: Parameters<CompletionGateway["complete"]>[0],
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] =>
    request.messages.map((message) => {
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
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
      return message;
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
        toolCalls: (message.tool_calls ?? []).flatMap((toolCall) =>
          toolCall.type === "function"
            ? [
                {
                  id: toolCall.id,
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
              ]
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
      const toolCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const content = choice.delta.content;
        if (content) {
          contentParts.push(content);
          yield { type: "text_delta" as const, content };
        }
        for (const toolCall of choice.delta.tool_calls ?? []) {
          const current = toolCalls.get(toolCall.index) ?? {
            id: toolCall.id ?? `tool-call-${toolCall.index}`,
            name: "",
            arguments: "",
          };
          if (toolCall.id) current.id = toolCall.id;
          if (toolCall.function?.name) current.name += toolCall.function.name;
          if (toolCall.function?.arguments) {
            current.arguments += toolCall.function.arguments;
          }
          toolCalls.set(toolCall.index, current);
        }
      }

      if (finishReason && finishReason !== "stop" && finishReason !== "tool_calls") {
        throw new Error(`OpenRouter stream ended unexpectedly (${finishReason})`);
      }
      yield {
        type: "completed" as const,
        response: {
          content: contentParts.join("") || null,
          toolCalls: [...toolCalls.values()],
        },
      };
    },
  };
}

async function createModel(request: DesktopRunRequest): Promise<ModelAdapter> {
  if (request.modelMode === "demo") return new FakeTutorModelAdapter();
  const apiKey = await resolveOpenRouterApiKey();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured. Add it to the repository .env file.");
  }
  return new OpenRouterModelAdapter({
    gateway: createOpenRouterGateway(apiKey),
    model: request.model,
  });
}

async function createHarness(
  workspaceRoot: string,
  workspace: WorkspaceAccess,
  agentHome: string,
  request: DesktopRunRequest,
): Promise<AgentHarness> {
  const detection = await new RuntimeDetector({
    workspaceEdits: workspace.stagedEdits(),
  }).detect(workspaceRoot);
  let commandTool: AgentTool;
  let sandboxes: SandboxManager | undefined;
  if (detection.status === "supported") {
    const runtimeDecision = new RuntimePolicy().evaluate(detection.plan);
    if (runtimeDecision.allowed) {
      const docker = desktopDockerSandbox(runtimeDecision.approvedPlan);
      const dockerStatus = await docker.preflight();
      if (!dockerStatus.ready) throw new Error(dockerStatus.message);
      sandboxes = new SandboxManager(
        docker,
        workspaceRoot,
        () => workspace.stagedEdits(),
      );
      const commandPlan = runtimeDecision.approvedPlan.plan.commands;
      const commandPolicy =
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
      commandTool = new RunCommandTool({
        policy: commandPolicy,
        sandboxes,
        description:
          commandPlan.kind === "exact"
            ? `Run one approved command in an isolated sandbox: ${commandPlan.recipes
                .map((recipe) => `${recipe.capability} = ${recipe.command} ${recipe.arguments.join(" ")}`)
                .join("; ")}. Use the recipe exactly.`
            : undefined,
        // Clean monorepo builds regenerate declarations and can exceed the runtime's
        // conservative 30-second default. This remains bounded by policy and harness budgets.
        timeoutMs: 120_000,
      });
    } else {
      commandTool = new UnsupportedRunCommandTool(runtimeDecision.reason);
    }
  } else {
    commandTool = new UnsupportedRunCommandTool(detection.message);
  }
  return new AgentHarness({
    model: await createModel(request),
    context: new FileContextProvider({ agentHome, workspaceRoot }),
    tools: new ToolRegistry([
      new InspectProjectTool(workspace),
      new ListFilesTool(workspace),
      new ReadFileTool(workspace),
      new SearchCodeTool(workspace),
      new ApplyPatchTool(workspace, sandboxes),
      new PreparePythonDependenciesTool({ workspace, sandboxes }),
      commandTool,
    ]),
    budgets: {
      maxRunDurationMs: 300_000,
      maxToolDurationMs: 240_000,
    },
  });
}

async function readRuntimeStatus(): Promise<RuntimeStatus> {
  const sandbox = desktopDockerSandbox(baselineNodeRuntimePlan());
  const docker = await sandbox.preflight();
  const cache = docker.ready
    ? await sandbox.listDependencyCaches().catch(() => ({ entries: [], totalBytes: 0 }))
    : { entries: [], totalBytes: 0 };
  return {
    openRouterConfigured: Boolean(await resolveOpenRouterApiKey()),
    defaultModel: process.env["OPENROUTER_MODEL"]?.trim() || DEFAULT_OPENROUTER_MODEL,
    dockerReady: docker.ready,
    dockerMessage: docker.message,
    dependencyCacheEntries: cache.entries.length,
    dependencyCacheBytes: cache.totalBytes,
  };
}

async function getRuntimeStatus(event: IpcMainInvokeEvent): Promise<RuntimeStatus> {
  assertTrustedSender(event);
  return await readRuntimeStatus();
}

async function clearDependencyCache(event: IpcMainInvokeEvent): Promise<RuntimeStatus> {
  assertTrustedSender(event);
  if (activeHarnesses.size > 0) {
    throw new Error("Wait for the active agent run to finish before clearing dependencies");
  }
  const sandbox = desktopDockerSandbox(baselineNodeRuntimePlan());
  const docker = await sandbox.preflight();
  if (!docker.ready) throw new Error(docker.message);
  const result = await sandbox.clearDependencyCaches();
  if (result.retained.length > 0) {
    throw new Error("Some dependency caches are currently in use and could not be removed");
  }
  return await readRuntimeStatus();
}

function requireSelectedWorkspace(): WorkspaceSelection {
  if (!selectedWorkspace) throw new Error("Choose a project folder first");
  return selectedWorkspace;
}

async function getConversation(event: IpcMainInvokeEvent): Promise<ConversationState> {
  assertTrustedSender(event);
  const workspace = requireSelectedWorkspace();
  return { messages: await conversationStore().load(workspace.id) };
}

async function clearConversation(event: IpcMainInvokeEvent): Promise<ConversationState> {
  assertTrustedSender(event);
  const workspace = requireSelectedWorkspace();
  await conversationStore().clear(workspace.id);
  return { messages: [] };
}

async function selectWorkspace(event: IpcMainInvokeEvent): Promise<WorkspaceSelection | null> {
  assertTrustedSender(event);
  const automatedWorkspace = process.env["PATHFORGE_AGENT_TEST_WORKSPACE"];
  if (process.env["PATHFORGE_AGENT_DOCKER_UI_SMOKE"] === "1" && automatedWorkspace) {
    selectedWorkspace = workspaceSelection(automatedWorkspace);
    return selectedWorkspace;
  }
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Choose a project for the PathForge Agent Lab",
    properties: ["openDirectory"],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;

  selectedWorkspace = workspaceSelection(path);
  return selectedWorkspace;
}

function workspaceSelection(path: string): WorkspaceSelection {
  return {
    id: `${basename(path).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "workspace"}-${createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 12)}`,
    name: basename(path),
    path,
  };
}

async function runTurn(
  event: IpcMainInvokeEvent,
  rawRequest: DesktopRunRequest,
): Promise<DesktopRunResult> {
  assertTrustedSender(event);
  const request = desktopRunRequestSchema.parse(rawRequest);
  const workspace = requireSelectedWorkspace();
  const messages = await conversationStore().load(workspace.id);

  const harness = await createHarness(
    workspace.path,
    stagedWorkspaces.get(workspace.id) ??
      (() => {
        const access = new WorkspaceAccess(workspace.path);
        stagedWorkspaces.set(workspace.id, access);
        return access;
      })(),
    await ensureAgentHome(),
    request,
  );
  const runId = randomUUID();
  if (activeHarnesses.has(request.clientRunId)) {
    throw new Error("This desktop run is already active");
  }
  activeHarnesses.set(request.clientRunId, { harness, runId });
  const events: AgentEvent[] = [];
  try {
    for await (const agentEvent of harness.runTurn({
      runId,
      workspaceId: workspace.id,
      preferredLanguage: request.preferredLanguage,
      currentNode: {
        id: 1,
        title: request.currentNodeTitle,
      },
      messages,
      userMessage: request.userMessage,
    })) {
      event.sender.send("agent-desktop:run-event", {
        clientRunId: request.clientRunId,
        event: agentEvent,
      });
      const previous = events.at(-1);
      if (agentEvent.type === "text_delta" && previous?.type === "text_delta") {
        previous.content += agentEvent.content;
      } else {
        events.push(agentEvent);
      }
    }
  } finally {
    activeHarnesses.delete(request.clientRunId);
  }

  let completed: Extract<AgentEvent, { type: "completed" }> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate?.type === "completed") {
      completed = candidate;
      break;
    }
  }
  let conversation = messages;
  if (completed) {
    conversation = (
      [
        ...messages,
        { role: "user", content: request.userMessage },
        { role: "assistant", content: completed.result.response },
      ] satisfies AgentMessage[]
    ).slice(-100);
    await conversationStore().save(workspace.id, conversation);
  }
  return { events, conversation };
}

async function cancelRun(
  event: IpcMainInvokeEvent,
  rawRequest: unknown,
): Promise<{ accepted: boolean }> {
  assertTrustedSender(event);
  const request = cancelRunRequestSchema.parse(rawRequest);
  const active = activeHarnesses.get(request.clientRunId);
  if (!active) return { accepted: false };
  await active.harness.cancel(active.runId);
  return { accepted: true };
}

async function cancelActiveRunsAndWait(timeoutMs = 30_000): Promise<void> {
  for (const active of activeHarnesses.values()) {
    await active.harness.cancel(active.runId);
  }
  const startedAt = Date.now();
  while (activeHarnesses.size > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#f4f1e8",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  if (process.env["PATHFORGE_AGENT_SMOKE_TEST"] === "1") {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.destroy();
      app.exit(0);
    });
    mainWindow.webContents.once("did-fail-load", (_event, code, description) => {
      console.error(`Desktop renderer failed to load (${code}): ${description}`);
      app.exit(1);
    });
  } else if (process.env["PATHFORGE_AGENT_DOCKER_UI_SMOKE"] === "1") {
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        const result = (await mainWindow!.webContents.executeJavaScript(`
          (async () => {
            const waitFor = async (predicate, timeoutMs = 240000) => {
              const startedAt = Date.now();
              while (!predicate()) {
                if (Date.now() - startedAt > timeoutMs) throw new Error("UI smoke timed out");
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            };
            const button = (label) => [...document.querySelectorAll("button")]
              .find((candidate) => candidate.textContent?.trim() === label);
            await waitFor(() => button("Choose folder"));
            button("Choose folder").click();
            await waitFor(() => document.body.innerText.includes("docker-typescript-workspace"));
            const demoButton = [...document.querySelectorAll("button")]
              .find((candidate) => candidate.querySelector("strong")?.textContent === "Demo");
            demoButton.click();
            const textarea = document.querySelector("textarea");
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
            setter.call(textarea, "Please run pnpm run typecheck in the Docker sandbox.");
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            await waitFor(() => {
              const run = button("Run one agent turn");
              return run && !run.disabled;
            });
            button("Run one agent turn").click();
            await waitFor(() => {
              const cancel = button("Cancel run");
              return cancel && !cancel.disabled;
            });
            const cancelWasEnabled = true;
            await waitFor(() => document.body.innerText.includes("Run completed"));
            const completedText = document.body.innerText;
            const preparingVisible = completedText.includes("sandbox preparing");
            const runningVisible = completedText.includes("command running");
            const runtimePlanVisible = completedText.includes("node 24 with pnpm is ready");
            setter.call(textarea, "Please run pnpm run test in the Docker sandbox.");
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            await waitFor(() => {
              const run = button("Run one agent turn");
              return run && !run.disabled;
            });
            button("Run one agent turn").click();
            await waitFor(() =>
              document.querySelector(".timeline")?.innerText.includes(
                "Running pnpm run test inside Docker.",
              ),
            );
            button("Cancel run").click();
            try {
              await waitFor(() => document.body.innerText.includes("Run failed"), 30000);
            } catch {
              throw new Error("Cancellation state: " + document.body.innerText.slice(-4000));
            }
            const text = document.body.innerText;
            await window.agentDesktop.clearConversation();
            return {
              dockerReady: text.includes("Docker ready"),
              preparingVisible,
              runningVisible,
              completedVisible: completedText.includes("Run completed"),
              runtimePlanVisible,
              cancelWasEnabled,
              cancellationVisible: text.includes("Run failed · CANCELLED"),
            };
          })()
        `)) as Record<string, boolean>;
        if (Object.values(result).some((value) => !value)) {
          throw new Error(`UI smoke assertions failed: ${JSON.stringify(result)}`);
        }
        console.log(`PASS Docker desktop UI journey ${JSON.stringify(result)}`);
        mainWindow?.destroy();
        app.exit(0);
      } catch (error) {
        console.error(error);
        await cancelActiveRunsAndWait();
        closingAfterCleanup = true;
        mainWindow?.destroy();
        app.exit(1);
      }
    });
  }
  // Desktop-host mode: when PATHFORGE_APP_URL is set (e.g. the PathForge web app
  // at http://localhost:3000), host that UI in the shell so it gains local
  // workspace + sandbox access via the exposed `agentDesktop` bridge. Otherwise
  // load the bundled lab renderer (the verified default). The smoke-test flags
  // above never set PATHFORGE_APP_URL, so those journeys are unaffected.
  const pathforgeAppUrl = process.env["PATHFORGE_APP_URL"]?.trim();
  if (pathforgeAppUrl) {
    void mainWindow.loadURL(pathforgeAppUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
  }
  let closingAfterCleanup = false;
  mainWindow.on("close", (event) => {
    if (activeHarnesses.size === 0 || closingAfterCleanup) return;
    event.preventDefault();
    closingAfterCleanup = true;
    void cancelActiveRunsAndWait().finally(() => mainWindow?.destroy());
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function pathforgeBackendPort(): number {
  return Number(process.env["PATHFORGE_BACKEND_PORT"]?.trim() || "5000");
}

/** Resolves once the backend answers on its port (any HTTP response = ready). */
async function waitForBackend(port: number, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = await new Promise<boolean>((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/api/agent-runs", method: "GET", timeout: 2_000 },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`PathForge backend did not become ready on port ${port}`);
}

/**
 * Starts the bundled PathForge API server as a managed child process in
 * fully-local mode (embedded DB in the app's data dir, no Clerk). The Electron
 * binary runs it as plain Node (ELECTRON_RUN_AS_NODE), so no separate Node
 * install is required. Paths default to the monorepo dev layout and are
 * overridable for packaged builds.
 */
async function startPathforgeBackend(): Promise<void> {
  if (backendProcess) return;
  const port = pathforgeBackendPort();
  const backendEntry =
    process.env["PATHFORGE_BACKEND_ENTRY"]?.trim() ||
    join(__dirname, "..", "..", "api-server", "dist", "index.mjs");
  const migrationsDir =
    process.env["PATHFORGE_MIGRATIONS_DIR"]?.trim() ||
    join(__dirname, "..", "..", "..", "lib", "db", "drizzle");
  const localDb =
    process.env["PATHFORGE_LOCAL_DB"]?.trim() || join(app.getPath("userData"), "pathforge-db");
  const apiKey = await resolveOpenRouterApiKey();

  backendProcess = spawn(process.execPath, [backendEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      PATHFORGE_LOCAL_MODE: "1",
      PATHFORGE_LOCAL_DB: localDb,
      PATHFORGE_MIGRATIONS_DIR: migrationsDir,
      ...(apiKey ? { OPENROUTER_API_KEY: apiKey } : {}),
    },
    stdio: "inherit",
  });
  backendProcess.on("exit", () => {
    backendProcess = null;
  });
  await waitForBackend(port);
}

function stopPathforgeBackend(): void {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

app.whenReady().then(async () => {
  ipcMain.handle("agent-desktop:select-workspace", selectWorkspace);
  ipcMain.handle("agent-desktop:get-runtime-status", getRuntimeStatus);
  ipcMain.handle("agent-desktop:get-conversation", getConversation);
  ipcMain.handle("agent-desktop:clear-conversation", clearConversation);
  ipcMain.handle("agent-desktop:clear-dependency-cache", clearDependencyCache);
  ipcMain.handle("agent-desktop:run-turn", runTurn);
  ipcMain.handle("agent-desktop:cancel-run", cancelRun);

  // When hosting the PathForge UI, run its backend in-process so the user only
  // launches one app. (The bundled lab renderer path spawns nothing.)
  if (process.env["PATHFORGE_APP_URL"]?.trim()) {
    try {
      await startPathforgeBackend();
    } catch (error) {
      console.error("Failed to start the PathForge backend:", error);
    }
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", stopPathforgeBackend);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
