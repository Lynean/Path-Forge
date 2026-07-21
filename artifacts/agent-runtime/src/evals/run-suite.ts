import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDecision, ModelTurnContext } from "../contracts";
import { FileContextProvider } from "../context/file-context-provider";
import { StaticContextProvider } from "../context/context-provider";
import { RuntimeDetector } from "../environment/runtime-detector";
import { createPythonRuntimePlan } from "../environment/runtime-plan";
import { RuntimePolicy } from "../environment/runtime-policy";
import type {
  CompletionGateway,
  CompletionRequest,
  CompletionResponse,
  CompletionStreamEvent,
} from "../model/completion-gateway";
import { OpenRouterModelAdapter } from "../model/openrouter-model-adapter";
import type { ModelAdapter } from "../model/model-adapter";
import { AllowlistedCommandPolicy, ExactCommandPolicy } from "../policy/command-policy";
import { AgentHarness } from "../runtime/harness";
import { SandboxManager } from "../sandbox/sandbox-manager";
import { FakeSandbox } from "../testing/fake-sandbox";
import { FakeTutorModelAdapter } from "../testing/fake-model-adapter";
import { InvalidToolArgumentsModelAdapter } from "../testing/invalid-tool-arguments-model-adapter";
import { MockInspectProjectTool } from "../testing/mock-tools";
import { ToolRegistry } from "../tools/tool";
import { RunCommandTool, UnsupportedRunCommandTool } from "../tools/run-command-tool";
import { ApplyPatchTool } from "../tools/workspace-edit-tool";
import {
  InspectProjectTool,
  ListFilesTool,
  ReadFileTool,
  SearchCodeTool,
} from "../tools/workspace-tools";
import { WorkspaceAccess } from "../workspace/workspace-access";
import { evalCases } from "./cases";

const harness = new AgentHarness({
  model: new FakeTutorModelAdapter(),
  tools: new ToolRegistry([new MockInspectProjectTool()]),
  maxTurns: 4,
});

let failures = 0;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const runtimeFixtureRoot = await mkdtemp(join(tmpdir(), "pathforge-runtime-plan-eval-"));
try {
  const nodeWorkspace = join(runtimeFixtureRoot, "node");
  const pythonWorkspace = join(runtimeFixtureRoot, "python");
  const unlockedPythonWorkspace = join(runtimeFixtureRoot, "python-without-lock");
  const pipWorkspace = join(runtimeFixtureRoot, "python-pip");
  const unsafeUvWorkspace = join(runtimeFixtureRoot, "python-unsafe-uv");
  const unpinnedPipWorkspace = join(runtimeFixtureRoot, "python-unpinned-pip");
  await Promise.all([
    mkdir(nodeWorkspace, { recursive: true }),
    mkdir(pythonWorkspace, { recursive: true }),
    mkdir(unlockedPythonWorkspace, { recursive: true }),
    mkdir(pipWorkspace, { recursive: true }),
    mkdir(unsafeUvWorkspace, { recursive: true }),
    mkdir(unpinnedPipWorkspace, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(nodeWorkspace, "package.json"), '{"name":"runtime-plan-fixture"}\n'),
    writeFile(join(nodeWorkspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
    writeFile(join(pythonWorkspace, "pyproject.toml"), "[project]\nname='future-python'\n"),
    writeFile(
      join(pythonWorkspace, "uv.lock"),
      'version = 1\nrevision = 3\nrequires-python = ">=3.13"\n[[package]]\nname = "pytest"\nversion = "9.1.1"\nsource = { registry = "https://pypi.org/simple" }\n',
    ),
    writeFile(join(unlockedPythonWorkspace, "pyproject.toml"), "[project]\nname='unlocked-python'\n"),
    writeFile(join(pipWorkspace, "requirements.txt"), "pytest==9.1.1\n"),
    writeFile(join(unsafeUvWorkspace, "pyproject.toml"), "[project]\nname='unsafe-source'\n"),
    writeFile(
      join(unsafeUvWorkspace, "uv.lock"),
      'version = 1\n[[package]]\nname = "example"\nversion = "1.0.0"\nsource = { registry = "https://packages.example.com/simple" }\n',
    ),
    writeFile(join(unpinnedPipWorkspace, "requirements.txt"), "requests>=2\n"),
  ]);

  const detector = new RuntimeDetector();
  const nodeDetection = await detector.detect(nodeWorkspace);
  if (
    nodeDetection.status === "supported" &&
    nodeDetection.plan.ecosystem === "node" &&
    nodeDetection.plan.dependencies.kind === "locked" &&
    nodeDetection.plan.dependencies.manager === "pnpm"
  ) {
    console.log("PASS runtime detector produces a typed locked Node plan");
  } else {
    failures += 1;
    console.error("FAIL runtime detector produces a typed locked Node plan");
  }

  const runtimePolicy = new RuntimePolicy();
  if (
    nodeDetection.status === "supported" &&
    runtimePolicy.evaluate(nodeDetection.plan).allowed
  ) {
    console.log("PASS runtime policy approves the reviewed deterministic Node recipe");
  } else {
    failures += 1;
    console.error("FAIL runtime policy approves the reviewed deterministic Node recipe");
  }

  const untrustedDecision =
    nodeDetection.status === "supported"
      ? runtimePolicy.evaluate({ ...nodeDetection.plan, baseImage: "random-user/node:latest" })
      : null;
  if (untrustedDecision?.allowed === false) {
    console.log("PASS runtime policy rejects an untrusted base image");
  } else {
    failures += 1;
    console.error("FAIL runtime policy rejects an untrusted base image");
  }

  const pythonDetection = await detector.detect(pythonWorkspace);
  if (
    pythonDetection.status === "supported" &&
    pythonDetection.plan.ecosystem === "python" &&
    pythonDetection.plan.dependencies.manager === "uv" &&
    runtimePolicy.evaluate(pythonDetection.plan).allowed
  ) {
    console.log("PASS runtime detector and policy approve a locked Python uv plan");
  } else {
    failures += 1;
    console.error("FAIL runtime detector and policy approve a locked Python uv plan");
  }

  const pythonCommands =
    pythonDetection.status === "supported" && pythonDetection.plan.commands.kind === "exact"
      ? pythonDetection.plan.commands.recipes
      : [];
  const exactPolicy = new ExactCommandPolicy({ commands: pythonCommands });
  const approvedPythonTest = exactPolicy.evaluate({
    command: "uv",
    arguments: ["run", "--offline", "--frozen", "--no-sync", "pytest"],
    workingDirectory: ".",
    timeoutMs: 30_000,
    maxOutputCharacters: 10_000,
  });
  if (approvedPythonTest.allowed) {
    console.log("PASS exact command policy permits the reviewed Python test recipe");
  } else {
    failures += 1;
    console.error("FAIL exact command policy permits the reviewed Python test recipe");
  }

  const alteredPythonTest = exactPolicy.evaluate({
    command: "uv",
    arguments: ["run", "pytest", "--override-ini", "addopts=-s"],
    workingDirectory: ".",
    timeoutMs: 30_000,
    maxOutputCharacters: 10_000,
  });
  if (!alteredPythonTest.allowed && alteredPythonTest.code === "ARGUMENTS_NOT_ALLOWED") {
    console.log("PASS exact command policy rejects altered Python arguments");
  } else {
    failures += 1;
    console.error("FAIL exact command policy rejects altered Python arguments");
  }

  const pipDetection = await detector.detect(pipWorkspace);
  if (
    pipDetection.status === "supported" &&
    pipDetection.plan.ecosystem === "python" &&
    pipDetection.plan.dependencies.manager === "pip" &&
    pipDetection.plan.commands.recipes.some(
      (recipe) =>
        recipe.capability === "test" &&
        recipe.command === "python" &&
        JSON.stringify(recipe.arguments) === JSON.stringify(["-m", "pytest"]),
    ) &&
    runtimePolicy.evaluate(pipDetection.plan).allowed
  ) {
    console.log("PASS pinned requirements produce a project-aware approved pip plan");
  } else {
    failures += 1;
    console.error("FAIL pinned requirements produce a project-aware approved pip plan");
  }

  const syntaxOnlyPlan = createPythonRuntimePlan({
    dependency: { manager: "pip", hashesRequired: false },
  });
  if (
    syntaxOnlyPlan.commands.recipes.length === 1 &&
    syntaxOnlyPlan.commands.recipes[0]?.capability === "typecheck" &&
    syntaxOnlyPlan.commands.recipes[0]?.arguments.includes("compileall")
  ) {
    console.log("PASS Python projects without test tools expose only the universal syntax check");
  } else {
    failures += 1;
    console.error("FAIL Python projects without test tools expose only the universal syntax check");
  }

  const unsafeUvDetection = await detector.detect(unsafeUvWorkspace);
  if (unsafeUvDetection.status === "unsupported") {
    console.log("PASS uv locks with unapproved registries are rejected before Docker");
  } else {
    failures += 1;
    console.error("FAIL uv locks with unapproved registries are rejected before Docker");
  }

  const unpinnedPipDetection = await detector.detect(unpinnedPipWorkspace);
  if (unpinnedPipDetection.status === "unsupported") {
    console.log("PASS unpinned pip requirements are rejected before Docker");
  } else {
    failures += 1;
    console.error("FAIL unpinned pip requirements are rejected before Docker");
  }

  const unsupportedDetection = await detector.detect(unlockedPythonWorkspace);
  const unsupportedOutput =
    unsupportedDetection.status === "unsupported"
      ? await new UnsupportedRunCommandTool(unsupportedDetection.message).execute({})
      : null;
  if (
    unsupportedDetection.status === "unsupported" &&
    (unsupportedOutput as Record<string, unknown> | null)?.["error"] === "UNSUPPORTED_RUNTIME"
  ) {
    console.log("PASS unlocked Python projects return an explicit result without Docker");
  } else {
    failures += 1;
    console.error("FAIL unlocked Python projects return an explicit result without Docker");
  }
} finally {
  await rm(runtimeFixtureRoot, { recursive: true, force: true });
}

for (const testCase of evalCases) {
  const events = [];
  for await (const event of harness.runTurn(testCase.input)) {
    events.push(event);
  }

  const completed = events.find((event) => event.type === "completed");
  const failed = events.find((event) => event.type === "failed");
  const problems: string[] = [];

  if (failed) {
    problems.push(`run failed: ${failed.code} ${failed.message}`);
  }
  if (!completed) {
    problems.push("run did not produce a completed event");
  } else {
    const { result } = completed;
    const normalizedResponse = result.response.toLowerCase();

    if (JSON.stringify(result.toolCalls) !== JSON.stringify(testCase.expected.expectedTools)) {
      problems.push(
        `expected tools ${JSON.stringify(testCase.expected.expectedTools)}, got ${JSON.stringify(result.toolCalls)}`,
      );
    }
    if (result.turns > testCase.expected.maximumTurns) {
      problems.push(`expected at most ${testCase.expected.maximumTurns} turns, got ${result.turns}`);
    }
    for (const phrase of testCase.expected.requiredPhrases) {
      if (!normalizedResponse.includes(phrase.toLowerCase())) {
        problems.push(`missing required phrase: ${phrase}`);
      }
    }
    for (const phrase of testCase.expected.forbiddenPhrases) {
      if (normalizedResponse.includes(phrase.toLowerCase())) {
        problems.push(`included forbidden phrase: ${phrase}`);
      }
    }
  }

  if (problems.length === 0) {
    console.log(`PASS ${testCase.name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${testCase.name}`);
    for (const problem of problems) console.error(`  - ${problem}`);
  }
}

const invalidArgumentsTool = new MockInspectProjectTool();
const invalidArgumentsHarness = new AgentHarness({
  model: new InvalidToolArgumentsModelAdapter(),
  tools: new ToolRegistry([invalidArgumentsTool]),
});
const invalidArgumentsInput = evalCases[0]?.input;

if (!invalidArgumentsInput) {
  throw new Error("The invalid-arguments eval needs a base input case");
}

const invalidArgumentsEvents = [];
for await (const event of invalidArgumentsHarness.runTurn(invalidArgumentsInput)) {
  invalidArgumentsEvents.push(event);
}

const invalidArgumentsFailure = invalidArgumentsEvents.find(
  (event) => event.type === "failed",
);
const invalidArgumentsProblems: string[] = [];

if (
  invalidArgumentsFailure?.type !== "failed" ||
  invalidArgumentsFailure.code !== "INVALID_TOOL_ARGUMENTS"
) {
  invalidArgumentsProblems.push("expected an INVALID_TOOL_ARGUMENTS failure");
}
if (invalidArgumentsTool.executionCount !== 0) {
  invalidArgumentsProblems.push("tool execute was called despite invalid arguments");
}
if (
  invalidArgumentsEvents.some(
    (event) => event.type === "tool_started" || event.type === "tool_completed",
  )
) {
  invalidArgumentsProblems.push("an invalid tool call emitted execution events");
}

if (invalidArgumentsProblems.length === 0) {
  console.log("PASS invalid tool arguments are blocked before execution");
} else {
  failures += 1;
  console.error("FAIL invalid tool arguments are blocked before execution");
  for (const problem of invalidArgumentsProblems) console.error(`  - ${problem}`);
}

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixtureWorkspaceRoot = join(fixtureRoot, "workspace");
const contextProvider = new FileContextProvider({
  agentHome: join(fixtureRoot, "agent-home"),
  workspaceRoot: fixtureWorkspaceRoot,
});
const documents = await contextProvider.load(invalidArgumentsInput);
const workspace = new WorkspaceAccess(fixtureWorkspaceRoot);
const readFileTool = new ReadFileTool(workspace);
const listFilesTool = new ListFilesTool(workspace);
const searchCodeTool = new SearchCodeTool(workspace);
const inspectProjectTool = new InspectProjectTool(workspace);
const workspaceProblems: string[] = [];

if (!documents.soul.includes("Inspect evidence")) {
  workspaceProblems.push("SOUL.md was not loaded");
}
if (!documents.user.includes("learning TypeScript")) {
  workspaceProblems.push("USER.md was not loaded");
}
if (!documents.project.includes("Weather CLI")) {
  workspaceProblems.push("PROJECT.md was not loaded");
}

const readResult = (await readFileTool.execute({ path: "src/index.ts" })) as {
  content: string;
};
if (!readResult.content.includes("formatTemperature")) {
  workspaceProblems.push("read_file did not return the fixture source");
}

const listResult = (await listFilesTool.execute({ path: ".", depth: 2 })) as {
  entries: Array<{ path: string }>;
};
if (!listResult.entries.some((entry) => entry.path === "src/index.ts")) {
  workspaceProblems.push("list_files did not discover the fixture source");
}

const searchResult = (await searchCodeTool.execute({
  query: "formatTemperature",
  path: ".",
  maxResults: 10,
})) as { matches: Array<{ path: string }> };
if (!searchResult.matches.some((match) => match.path === "src/index.ts")) {
  workspaceProblems.push("search_code did not find the fixture symbol");
}

const inspectionResult = (await inspectProjectTool.execute({})) as {
  manifests: Record<string, string>;
};
if (!inspectionResult.manifests["package.json"]?.includes("weather-cli")) {
  workspaceProblems.push("inspect_project did not read package.json");
}

let traversalWasBlocked = false;
try {
  await readFileTool.execute({ path: "../agent-home/SOUL.md" });
} catch {
  traversalWasBlocked = true;
}
if (!traversalWasBlocked) {
  workspaceProblems.push("read_file allowed traversal outside the workspace");
}

if (workspaceProblems.length === 0) {
  console.log("PASS context documents load and workspace access stays confined");
} else {
  failures += 1;
  console.error("FAIL context documents load and workspace access stays confined");
  for (const problem of workspaceProblems) console.error(`  - ${problem}`);
}

class ScriptedCompletionGateway implements CompletionGateway {
  readonly requests: CompletionRequest[] = [];

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const hasObservation = request.messages.some(
      (message) => message.role === "tool" && message.content.includes('"mocked": true'),
    );
    return hasObservation
      ? {
          content: "I used the validated inspection observation before answering.",
          toolCalls: [],
        }
      : {
          content: null,
          toolCalls: [{ id: "scripted-inspection", name: "inspect_project", arguments: "{}" }],
        };
  }
}

const scriptedGateway = new ScriptedCompletionGateway();
const adapterTool = new MockInspectProjectTool();
const adapterHarness = new AgentHarness({
  model: new OpenRouterModelAdapter({
    gateway: scriptedGateway,
    model: "test/tool-capable-model",
  }),
  context: new StaticContextProvider({
    soul: "Teach from evidence.",
    user: "The learner prefers concise examples.",
    project: "A TypeScript weather CLI.",
  }),
  tools: new ToolRegistry([adapterTool]),
});
const adapterEvents = [];
for await (const event of adapterHarness.runTurn(invalidArgumentsInput)) {
  adapterEvents.push(event);
}
const adapterCompleted = adapterEvents.find((event) => event.type === "completed");
const adapterProblems: string[] = [];
const firstAdapterRequest = scriptedGateway.requests[0];
const secondAdapterRequest = scriptedGateway.requests[1];

if (adapterCompleted?.type !== "completed") {
  adapterProblems.push("OpenRouter adapter run did not complete");
} else if (JSON.stringify(adapterCompleted.result.toolCalls) !== '["inspect_project"]') {
  adapterProblems.push("OpenRouter adapter did not complete the requested tool loop");
}
if (adapterTool.executionCount !== 1) {
  adapterProblems.push("OpenRouter adapter tool was not executed exactly once");
}
if (scriptedGateway.requests.length !== 2) {
  adapterProblems.push("OpenRouter adapter did not make the expected two model decisions");
}
const firstSystemMessage = firstAdapterRequest?.messages.find(
  (message) => message.role === "system",
);
const firstSystemContent =
  typeof firstSystemMessage?.content === "string" ? firstSystemMessage.content : "";
if (
  !firstSystemContent.includes("Teach from evidence.") ||
  !firstSystemContent.includes("A TypeScript weather CLI.") ||
  !firstSystemContent.includes("Respond in English")
) {
  adapterProblems.push("prompt did not contain the resolved Hermes-style context");
}
if (firstAdapterRequest?.tools[0]?.function.name !== "inspect_project") {
  adapterProblems.push("tool definition was not exposed to the completion gateway");
}
const structuredToolResult = secondAdapterRequest?.messages.find(
  (message) => message.role === "tool" && message.toolCallId === "scripted-inspection",
);
if (
  typeof structuredToolResult?.content !== "string" ||
  !structuredToolResult.content.includes('"mocked": true')
) {
  adapterProblems.push("validated tool observation was not included in the next model turn");
}
if (firstAdapterRequest?.parallelToolCalls !== false) {
  adapterProblems.push("parallel tool calls must remain disabled for the educational loop");
}

if (adapterProblems.length === 0) {
  console.log("PASS OpenRouter adapter assembles context and completes a tool loop");
} else {
  failures += 1;
  console.error("FAIL OpenRouter adapter assembles context and completes a tool loop");
  for (const problem of adapterProblems) console.error(`  - ${problem}`);
}

class RepeatingCompletionGateway implements CompletionGateway {
  readonly requests: CompletionRequest[] = [];

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const duplicateWasExplained = request.messages.some(
      (message) =>
        message.role === "tool" && message.content.includes("DUPLICATE_TOOL_CALL"),
    );
    return duplicateWasExplained
      ? {
          content: "I will use the existing listing instead of requesting it again.",
          toolCalls: [],
        }
      : {
          content: null,
          toolCalls: [
            {
              id: `repeated-listing-${this.requests.length}`,
              name: "inspect_project",
              arguments: "{}",
            },
          ],
        };
  }
}

const repeatingGateway = new RepeatingCompletionGateway();
const duplicateProtectedTool = new MockInspectProjectTool();
const duplicateProtectedHarness = new AgentHarness({
  model: new OpenRouterModelAdapter({
    gateway: repeatingGateway,
    model: "test/repeating-model",
  }),
  tools: new ToolRegistry([duplicateProtectedTool]),
});
const duplicateProtectedEvents = [];
for await (const event of duplicateProtectedHarness.runTurn(invalidArgumentsInput)) {
  duplicateProtectedEvents.push(event);
}
const duplicateProtectedProblems: string[] = [];

if (duplicateProtectedTool.executionCount !== 1) {
  duplicateProtectedProblems.push("the identical tool call executed more than once");
}
if (
  !duplicateProtectedEvents.some(
    (event) =>
      event.type === "tool_rejected" && event.code === "DUPLICATE_TOOL_CALL",
  )
) {
  duplicateProtectedProblems.push("the repeated call was not rejected with an observable event");
}
if (!duplicateProtectedEvents.some((event) => event.type === "completed")) {
  duplicateProtectedProblems.push("the model did not recover after receiving duplicate guidance");
}
if (repeatingGateway.requests.length !== 3) {
  duplicateProtectedProblems.push("the duplicate recovery used an unexpected number of turns");
}

if (duplicateProtectedProblems.length === 0) {
  console.log("PASS duplicate tool calls are blocked and returned as structured guidance");
} else {
  failures += 1;
  console.error("FAIL duplicate tool calls are blocked and returned as structured guidance");
  for (const problem of duplicateProtectedProblems) console.error(`  - ${problem}`);
}

class StreamingCompletionGateway implements CompletionGateway {
  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    throw new Error("Streaming path should be used");
  }

  async *stream(_request: CompletionRequest): AsyncIterable<CompletionStreamEvent> {
    yield { type: "text_delta", content: "Streamed " };
    yield { type: "text_delta", content: "answer." };
    yield {
      type: "completed",
      response: { content: "Streamed answer.", toolCalls: [] },
    };
  }
}

const streamingHarness = new AgentHarness({
  model: new OpenRouterModelAdapter({
    gateway: new StreamingCompletionGateway(),
    model: "test/streaming-model",
  }),
  tools: new ToolRegistry([new MockInspectProjectTool()]),
});
const streamingEvents = [];
for await (const event of streamingHarness.runTurn(invalidArgumentsInput)) {
  streamingEvents.push(event);
}
const streamedText = streamingEvents
  .filter((event) => event.type === "text_delta")
  .map((event) => event.content)
  .join("");
const streamingProblems: string[] = [];
if (streamedText !== "Streamed answer.") {
  streamingProblems.push(`expected incremental answer once, got ${JSON.stringify(streamedText)}`);
}
if (!streamingEvents.some((event) => event.type === "completed")) {
  streamingProblems.push("streaming run did not produce a completed result");
}

if (streamingProblems.length === 0) {
  console.log("PASS model text deltas stream without duplicating the final answer");
} else {
  failures += 1;
  console.error("FAIL model text deltas stream without duplicating the final answer");
  for (const problem of streamingProblems) console.error(`  - ${problem}`);
}

const modelTurnBudgetHarness = new AgentHarness({
  model: new FakeTutorModelAdapter(),
  tools: new ToolRegistry([new MockInspectProjectTool()]),
  budgets: { maxModelTurns: 1 },
});
const modelTurnBudgetEvents = [];
for await (const event of modelTurnBudgetHarness.runTurn(invalidArgumentsInput)) {
  modelTurnBudgetEvents.push(event);
}
const modelTurnBudgetFailure = modelTurnBudgetEvents.find((event) => event.type === "failed");
if (
  modelTurnBudgetFailure?.type === "failed" &&
  modelTurnBudgetFailure.status === "budget_exceeded" &&
  modelTurnBudgetFailure.code === "MAX_MODEL_TURNS_EXCEEDED"
) {
  console.log("PASS model-turn budget stops an unfinished run with a standard status");
} else {
  failures += 1;
  console.error("FAIL model-turn budget stops an unfinished run with a standard status");
}

const toolCallBudgetGateway = new RepeatingCompletionGateway();
const toolCallBudgetTool = new MockInspectProjectTool();
const toolCallBudgetHarness = new AgentHarness({
  model: new OpenRouterModelAdapter({
    gateway: toolCallBudgetGateway,
    model: "test/tool-budget-model",
  }),
  tools: new ToolRegistry([toolCallBudgetTool]),
  budgets: { maxToolCalls: 1 },
});
const toolCallBudgetEvents = [];
for await (const event of toolCallBudgetHarness.runTurn(invalidArgumentsInput)) {
  toolCallBudgetEvents.push(event);
}
const toolCallBudgetFailure = toolCallBudgetEvents.find((event) => event.type === "failed");
if (
  toolCallBudgetFailure?.type === "failed" &&
  toolCallBudgetFailure.status === "budget_exceeded" &&
  toolCallBudgetFailure.code === "MAX_TOOL_CALLS_EXCEEDED" &&
  toolCallBudgetTool.executionCount === 1
) {
  console.log("PASS tool-call budget blocks execution beyond its configured limit");
} else {
  failures += 1;
  console.error("FAIL tool-call budget blocks execution beyond its configured limit");
}

class BlockingModelAdapter implements ModelAdapter {
  async decide(): Promise<never> {
    return await new Promise<never>(() => undefined);
  }
}

const cancellableHarness = new AgentHarness({
  model: new BlockingModelAdapter(),
  tools: new ToolRegistry([]),
});
const cancellableIterator = cancellableHarness.runTurn(invalidArgumentsInput)[Symbol.asyncIterator]();
await cancellableIterator.next();
await cancellableIterator.next();
const pendingCancelledEvent = cancellableIterator.next();
await cancellableHarness.cancel(invalidArgumentsInput.runId);
const cancelledEvent = await pendingCancelledEvent;
if (
  !cancelledEvent.done &&
  cancelledEvent.value.type === "failed" &&
  cancelledEvent.value.status === "cancelled" &&
  cancelledEvent.value.code === "CANCELLED"
) {
  console.log("PASS cancellation interrupts a pending model operation");
} else {
  failures += 1;
  console.error("FAIL cancellation interrupts a pending model operation");
}
await cancellableIterator.next();

const runTimeoutHarness = new AgentHarness({
  model: new BlockingModelAdapter(),
  tools: new ToolRegistry([]),
  budgets: { maxRunDurationMs: 10 },
});
const runTimeoutEvents = [];
for await (const event of runTimeoutHarness.runTurn({
  ...invalidArgumentsInput,
  runId: "run-timeout-eval",
})) {
  runTimeoutEvents.push(event);
}
const runTimeoutFailure = runTimeoutEvents.find((event) => event.type === "failed");
if (
  runTimeoutFailure?.type === "failed" &&
  runTimeoutFailure.status === "timed_out" &&
  runTimeoutFailure.code === "RUN_TIMEOUT"
) {
  console.log("PASS total run timeout interrupts a pending model operation");
} else {
  failures += 1;
  console.error("FAIL total run timeout interrupts a pending model operation");
}

class BlockingInspectProjectTool extends MockInspectProjectTool {
  override async execute(): Promise<never> {
    return await new Promise<never>(() => undefined);
  }
}

const toolTimeoutHarness = new AgentHarness({
  model: new FakeTutorModelAdapter(),
  tools: new ToolRegistry([new BlockingInspectProjectTool()]),
  budgets: { maxToolDurationMs: 10 },
});
const toolTimeoutEvents = [];
for await (const event of toolTimeoutHarness.runTurn({
  ...invalidArgumentsInput,
  runId: "tool-timeout-eval",
})) {
  toolTimeoutEvents.push(event);
}
const toolTimeoutFailure = toolTimeoutEvents.find((event) => event.type === "failed");
if (
  toolTimeoutFailure?.type === "failed" &&
  toolTimeoutFailure.status === "timed_out" &&
  toolTimeoutFailure.code === "TOOL_TIMEOUT"
) {
  console.log("PASS per-tool timeout interrupts a pending tool operation");
} else {
  failures += 1;
  console.error("FAIL per-tool timeout interrupts a pending tool operation");
}

const fakeSandboxAbort = new AbortController();
const fakeSandbox = new FakeSandbox({
  files: { "src/index.ts": "export const answer = 42;" },
  commandResults: {
    [FakeSandbox.commandKey("pnpm", ["run", "typecheck"])]: {
      exitCode: 0,
      stdout: "Types passed",
      stderr: "",
      timedOut: false,
      truncated: false,
      durationMs: 12,
    },
  },
});
const fakeSession = await fakeSandbox.prepare({
  runId: "fake-sandbox-eval",
  workspaceRoot: fixtureWorkspaceRoot,
  signal: fakeSandboxAbort.signal,
});
const fakeCommandResult = await fakeSandbox.execute(
  fakeSession,
  {
    command: "pnpm",
    arguments: ["run", "typecheck"],
    timeoutMs: 30_000,
    maxOutputCharacters: 50_000,
  },
  { signal: fakeSandboxAbort.signal },
);
const fakeFile = await fakeSandbox.readFile(
  fakeSession,
  "src/index.ts",
  { signal: fakeSandboxAbort.signal },
);
await fakeSandbox.dispose(fakeSession);
let disposedSessionWasBlocked = false;
try {
  await fakeSandbox.readFile(fakeSession, "src/index.ts", {
    signal: fakeSandboxAbort.signal,
  });
} catch {
  disposedSessionWasBlocked = true;
}
if (
  fakeCommandResult.exitCode === 0 &&
  fakeCommandResult.stdout === "Types passed" &&
  fakeFile.includes("answer = 42") &&
  fakeSandbox.commandRequests.length === 1 &&
  fakeSandbox.disposedSessionIds.includes(fakeSession.id) &&
  disposedSessionWasBlocked
) {
  console.log("PASS fake sandbox follows prepare, execute, read, and dispose lifecycle");
} else {
  failures += 1;
  console.error("FAIL fake sandbox follows prepare, execute, read, and dispose lifecycle");
}

const commandPolicy = new AllowlistedCommandPolicy();
const commandDefaults = {
  timeoutMs: 30_000,
  maxOutputCharacters: 50_000,
};
const allowedPolicyRequests = [
  { command: "pnpm", arguments: ["test"], ...commandDefaults },
  { command: "npm", arguments: ["run", "typecheck"], ...commandDefaults },
  {
    command: "pnpm",
    arguments: ["run", "build"],
    workingDirectory: "artifacts/app",
    ...commandDefaults,
  },
];
const rejectedPolicyRequests = [
  { command: "powershell", arguments: ["Remove-Item", "project"], ...commandDefaults },
  { command: "pnpm", arguments: ["build"], ...commandDefaults },
  { command: "pnpm", arguments: ["run", "dev"], ...commandDefaults },
  { command: "pnpm", arguments: ["run", "build", "&&", "echo"], ...commandDefaults },
  {
    command: "pnpm",
    arguments: ["test"],
    workingDirectory: "../outside",
    ...commandDefaults,
  },
  {
    command: "npm",
    arguments: ["test"],
    environment: { NODE_OPTIONS: "--require=payload.js" },
    ...commandDefaults,
  },
  { command: "npm", arguments: ["test"], timeoutMs: 500_000, maxOutputCharacters: 50_000 },
  { command: "npm", arguments: ["test"], timeoutMs: 30_000, maxOutputCharacters: 500_000 },
];
const policyAllowedExpectedRequests = allowedPolicyRequests.every(
  (request) => commandPolicy.evaluate(request).allowed,
);
const policyRejectedUnsafeRequests = rejectedPolicyRequests.every(
  (request) => !commandPolicy.evaluate(request).allowed,
);
if (policyAllowedExpectedRequests && policyRejectedUnsafeRequests) {
  console.log("PASS command policy uses an exact allowlist and rejects unsafe request structure");
} else {
  failures += 1;
  console.error("FAIL command policy uses an exact allowlist and rejects unsafe request structure");
}

class AllowedCommandSequenceModel implements ModelAdapter {
  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    if (context.turn === 1) {
      return {
        type: "tool_call",
        call: {
          id: "command-test",
          name: "run_command",
          arguments: { command: "pnpm", arguments: ["test"], workingDirectory: "." },
        },
      };
    }
    if (context.turn === 2) {
      return {
        type: "tool_call",
        call: {
          id: "command-typecheck",
          name: "run_command",
          arguments: {
            command: "pnpm",
            arguments: ["run", "typecheck"],
            workingDirectory: ".",
          },
        },
      };
    }
    return {
      type: "final",
      response: "Tests and typecheck completed in the sandbox.",
      proposedActions: [{ type: "none", reason: "The commands supplied sufficient evidence." }],
    };
  }
}

function fakeSuccessfulCommand(stdout: string) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 10,
  };
}

const commandSandbox = new FakeSandbox({
  commandResults: {
    [FakeSandbox.commandKey("pnpm", ["test"])]: fakeSuccessfulCommand("2 tests passed"),
    [FakeSandbox.commandKey("pnpm", ["run", "typecheck"])]:
      fakeSuccessfulCommand("Types passed"),
  },
});
const commandManager = new SandboxManager(commandSandbox, fixtureWorkspaceRoot);
const allowedCommandHarness = new AgentHarness({
  model: new AllowedCommandSequenceModel(),
  tools: new ToolRegistry([
    new RunCommandTool({
      policy: new AllowlistedCommandPolicy(),
      sandboxes: commandManager,
    }),
  ]),
});
const allowedCommandEvents = [];
for await (const event of allowedCommandHarness.runTurn({
  ...invalidArgumentsInput,
  runId: "allowed-command-tool-eval",
})) {
  allowedCommandEvents.push(event);
}
const allowedCommandOutputs = allowedCommandEvents.flatMap((event) =>
  event.type === "tool_completed" ? [event.output as Record<string, unknown>] : [],
);
if (
  allowedCommandEvents.some((event) => event.type === "completed") &&
  allowedCommandOutputs.length === 2 &&
  allowedCommandOutputs.every((output) => output["ok"] === true) &&
  allowedCommandOutputs.some((output) => output["stdout"] === "2 tests passed") &&
  commandSandbox.preparedSessions.length === 1 &&
  commandSandbox.commandRequests.length === 2 &&
  commandSandbox.disposedSessionIds.length === 1
) {
  console.log("PASS run_command executes structured commands, reuses a session, and disposes it");
} else {
  failures += 1;
  console.error("FAIL run_command executes structured commands, reuses a session, and disposes it");
}

class RejectedCommandModel implements ModelAdapter {
  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    if (context.turn === 1) {
      return {
        type: "tool_call",
        call: {
          id: "rejected-command",
          name: "run_command",
          arguments: {
            command: "powershell",
            arguments: ["Remove-Item", "project"],
            workingDirectory: ".",
          },
        },
      };
    }
    return {
      type: "final",
      response: "The command was rejected by policy and was not executed.",
      proposedActions: [{ type: "none", reason: "Policy denied the command." }],
    };
  }
}

const rejectedCommandSandbox = new FakeSandbox();
const rejectedCommandHarness = new AgentHarness({
  model: new RejectedCommandModel(),
  tools: new ToolRegistry([
    new RunCommandTool({
      policy: new AllowlistedCommandPolicy(),
      sandboxes: new SandboxManager(rejectedCommandSandbox, fixtureWorkspaceRoot),
    }),
  ]),
});
const rejectedCommandEvents = [];
for await (const event of rejectedCommandHarness.runTurn({
  ...invalidArgumentsInput,
  runId: "rejected-command-tool-eval",
})) {
  rejectedCommandEvents.push(event);
}
const rejectedCommandOutput = rejectedCommandEvents.find(
  (event) => event.type === "tool_completed",
);
if (
  rejectedCommandOutput?.type === "tool_completed" &&
  (rejectedCommandOutput.output as Record<string, unknown>)["error"] === "POLICY_REJECTED" &&
  rejectedCommandSandbox.preparedSessions.length === 0 &&
  rejectedCommandSandbox.commandRequests.length === 0 &&
  rejectedCommandEvents.some((event) => event.type === "completed")
) {
  console.log("PASS rejected run_command returns evidence without preparing a sandbox");
} else {
  failures += 1;
  console.error("FAIL rejected run_command returns evidence without preparing a sandbox");
}

const cancellableCommandSandbox = new FakeSandbox({
  commandDelayMs: 60_000,
  commandResults: {
    [FakeSandbox.commandKey("pnpm", ["test"])]: fakeSuccessfulCommand("Too late"),
  },
});
const cancellableCommandHarness = new AgentHarness({
  model: new AllowedCommandSequenceModel(),
  tools: new ToolRegistry([
    new RunCommandTool({
      policy: new AllowlistedCommandPolicy(),
      sandboxes: new SandboxManager(cancellableCommandSandbox, fixtureWorkspaceRoot),
    }),
  ]),
});
const commandIterator = cancellableCommandHarness.runTurn({
  ...invalidArgumentsInput,
  runId: "cancelled-command-tool-eval",
})[Symbol.asyncIterator]();
await commandIterator.next();
await commandIterator.next();
await commandIterator.next();
await commandIterator.next();
await commandIterator.next();
await commandIterator.next();
const pendingCommandEvent = commandIterator.next();
for (let attempt = 0; attempt < 20 && cancellableCommandSandbox.commandRequests.length === 0; attempt += 1) {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
await cancellableCommandHarness.cancel("cancelled-command-tool-eval");
const cancelledCommandEvent = await pendingCommandEvent;
if (
  !cancelledCommandEvent.done &&
  cancelledCommandEvent.value.type === "failed" &&
  cancelledCommandEvent.value.status === "cancelled" &&
  cancellableCommandSandbox.commandRequests.length === 1 &&
  cancellableCommandSandbox.disposedSessionIds.length === 1
) {
  console.log("PASS cancellation reaches run_command and its sandbox session is disposed");
} else {
  failures += 1;
  console.error("FAIL cancellation reaches run_command and its sandbox session is disposed");
}
await commandIterator.next();

const editFixtureRoot = await mkdtemp(join(tmpdir(), "pathforge-edit-eval-"));
try {
  await mkdir(join(editFixtureRoot, "src"), { recursive: true });
  await writeFile(join(editFixtureRoot, "src", "answer.ts"), "export const answer = 41;\n");
  const editWorkspace = new WorkspaceAccess(editFixtureRoot);
  const editSandbox = new FakeSandbox();
  const editSandboxes = new SandboxManager(
    editSandbox,
    editFixtureRoot,
    () => editWorkspace.stagedEdits(),
  );
  const patchTool = new ApplyPatchTool(editWorkspace, editSandboxes);
  const editContext = { runId: "staged-edit-eval", signal: new AbortController().signal };
  const changed = (await patchTool.execute(
    {
      path: "src/answer.ts",
      oldText: "export const answer = 41;",
      newText: "export const answer = 42;",
    },
    editContext,
  )) as { diff: string; hostWorkspaceChanged: boolean };
  if (
    (await editWorkspace.readTextFile("src/answer.ts")).includes("42") &&
    (await readFile(join(editFixtureRoot, "src", "answer.ts"), "utf8")).includes("41") &&
    changed.diff.includes("-export const answer = 41;") &&
    changed.hostWorkspaceChanged === false
  ) {
    console.log("PASS exact replacements are staged with a diff while host files stay unchanged");
  } else {
    failures += 1;
    console.error("FAIL exact replacements are staged with a diff while host files stay unchanged");
  }

  await patchTool.execute(
    {
      path: "src/new-file.ts",
      oldText: null,
      newText: "export const created = true;\n",
    },
    editContext,
  );
  const stagedList = (await new ListFilesTool(editWorkspace).execute({
    path: "src",
    depth: 1,
  })) as { entries: Array<{ path: string }> };
  if (
    stagedList.entries.some((entry) => entry.path === "src/new-file.ts") &&
    !(await fileExists(join(editFixtureRoot, "src", "new-file.ts")))
  ) {
    console.log("PASS new files appear to agent tools but are not created in the host workspace");
  } else {
    failures += 1;
    console.error("FAIL new files appear to agent tools but are not created in the host workspace");
  }

  let protectedEditsRejected = 0;
  for (const path of [".env", "../escape.ts"]) {
    try {
      await patchTool.execute({ path, oldText: null, newText: "blocked\n" }, editContext);
    } catch {
      protectedEditsRejected += 1;
    }
  }
  if (protectedEditsRejected === 2) {
    console.log("PASS protected files and workspace traversal are rejected before staging");
  } else {
    failures += 1;
    console.error("FAIL protected files and workspace traversal are rejected before staging");
  }

  await editSandboxes.prepareRun(editContext.runId, editContext.signal);
  if (
    editSandbox.prepareRequests[0]?.workspaceEdits?.length === 2 &&
    editSandbox.prepareRequests[0]?.workspaceEdits?.some(
      (edit) => edit.path === "src/answer.ts" && edit.content.includes("42"),
    )
  ) {
    console.log("PASS Docker preparation receives the staged overlay for test execution");
  } else {
    failures += 1;
    console.error("FAIL Docker preparation receives the staged overlay for test execution");
  }
  await editSandboxes.disposeRun(editContext.runId);
} finally {
  await rm(editFixtureRoot, { recursive: true, force: true });
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`\nAll ${evalCases.length + 30} harness evals passed.`);
}
