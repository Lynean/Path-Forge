import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ApiClient, type LearningNode } from "./api-client";
import type { EnvironmentProposal, SseEvent } from "./sse";
import {
  findOpeningMessage,
  hydrateStepDetails,
  parseSlides,
  type Slide,
} from "./slides";
import { startEmbeddedApi } from "./server";

const cyan = (text: string): string => `\u001b[36m${text}\u001b[0m`;
const green = (text: string): string => `\u001b[32m${text}\u001b[0m`;
const yellow = (text: string): string => `\u001b[33m${text}\u001b[0m`;
const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`;
const red = (text: string): string => `\u001b[31m${text}\u001b[0m`;

function showHelp(): void {
  stdout.write(
    [
      "",
      cyan("Commands"),
      "  /next  move to the next step",
      "  /back  move to the previous step",
      "  /esc   leave this node and return to the node map",
      "  /done  complete this node and unlock its dependents",
      "  /help  show these commands",
      "  /quit  exit PathForge",
      "  Any other text is sent to the tutor.",
      "",
    ].join("\n"),
  );
}

function showNodeMap(nodes: LearningNode[]): LearningNode[] {
  const selectable = nodes.filter((node) => node.status !== "locked");
  stdout.write(`\n${cyan("Node map")}\n`);
  for (const [index, node] of selectable.entries()) {
    const badge = node.status === "completed" ? green("completed") : yellow("available");
    stdout.write(`  ${index + 1}. ${node.title} [${badge}]\n`);
  }
  const lockedCount = nodes.length - selectable.length;
  if (lockedCount > 0) stdout.write(dim(`  ${lockedCount} node(s) are still locked.\n`));
  return selectable;
}

function showSlide(slide: Slide, index: number, total: number): void {
  const label =
    slide.type === "intro"
      ? "Overview"
      : `Step ${slide.stepNumber ?? index}: ${slide.title ?? ""}`;
  stdout.write(`\n${cyan(`${label} (${index + 1}/${total})`)}\n\n`);
  stdout.write(`${slide.detailedContent ?? slide.content}\n\n`);
}

async function askRequired(reader: Interface, label: string): Promise<string> {
  while (true) {
    const value = (await reader.question(label)).trim();
    if (value) return value;
    stdout.write(yellow("Please enter a value.\n"));
  }
}

async function loadNode(
  api: ApiClient,
  projectId: number,
  node: LearningNode,
): Promise<Slide[]> {
  const history = await api.getChat(projectId, node.id);
  let opening = findOpeningMessage(history);
  if (!opening) {
    stdout.write(dim("\nGenerating the node session and inspecting your project…\n"));
    let generated = "";
    await api.streamOpening(projectId, node.id, (event) => {
      if (event.type === "inspecting") stdout.write(dim("  Inspecting current code…\n"));
      if (event.type === "tool_used") {
        stdout.write(dim(`  ↳ ${event.tool}${event.detail ? `: ${event.detail}` : ""}\n`));
      }
      if (event.type === "error") throw new Error(event.error ?? "Opening generation failed.");
      if (event.content) generated += event.content;
    });
    opening = generated;
  }
  if (!opening) throw new Error("The node did not produce a session plan.");
  return hydrateStepDetails(parseSlides(opening), history);
}

async function ensureStepDetail(
  api: ApiClient,
  projectId: number,
  nodeId: number,
  slide: Slide,
): Promise<void> {
  if (slide.type !== "step" || slide.detailedContent !== undefined) return;
  stdout.write(dim("Preparing this step from the relevant project code…\n"));
  let detail = "";
  await api.streamStepDetail(
    projectId,
    nodeId,
    {
      stepIndex: slide.stepNumber ?? 1,
      stepTitle: slide.title ?? `Step ${slide.stepNumber ?? 1}`,
      stepBrief: slide.content,
      ...(slide.agentNote ? { stepNote: slide.agentNote } : {}),
    },
    (event) => {
      if (event.type === "status" && event.message) stdout.write(dim(`  ${event.message}\n`));
      if (event.type === "error") throw new Error(event.error ?? "Step generation failed.");
      if (event.type === "chunk" && event.content) detail += event.content;
    },
  );
  if (!detail.trim()) throw new Error("The step generator returned no content.");
  slide.detailedContent = detail;
}

async function approveProposal(
  reader: Interface,
  api: ApiClient,
  projectId: number,
  proposal: EnvironmentProposal,
): Promise<void> {
  stdout.write(`\n${yellow("The tutor proposed a custom Docker environment:")}\n`);
  stdout.write(`  Base image: ${proposal.baseImage ?? "(missing)"}\n`);
  stdout.write(`  Setup: ${(proposal.setupCommands ?? []).join(" && ") || "(none)"}\n`);
  stdout.write(`  Run: ${proposal.runCommand ?? "(missing)"}\n`);
  if (proposal.reason) stdout.write(`  Why: ${proposal.reason}\n`);
  const answer = (await reader.question("Approve this environment for this project? [y/N] ")).trim();
  if (!/^y(es)?$/i.test(answer)) {
    stdout.write(dim("Environment proposal declined.\n"));
    return;
  }
  await api.approveEnvironment(projectId, proposal);
  stdout.write(green("Environment approved. Future tutor turns may use it.\n"));
}

async function tutorTurn(
  reader: Interface,
  api: ApiClient,
  projectId: number,
  node: LearningNode,
  slide: Slide,
  prompt: string,
  completedSteps: Set<number>,
): Promise<{ updatedOpening?: string }> {
  const context =
    slide.type === "step"
      ? `[Context: I'm on step ${slide.stepNumber} — "${slide.title}"]\n`
      : "";
  let streamed = "";
  let resolved: string | undefined;
  let proposal: EnvironmentProposal | undefined;
  let updatedOpening: string | undefined;

  await api.streamChat(
    projectId,
    node.id,
    `${context}${prompt}`,
    [...completedSteps],
    (event: SseEvent) => {
      if (event.type === "reset") {
        streamed = "";
        stdout.write(dim("\n  Retrying an interrupted model response…\n"));
      } else if (event.type === "tool_used") {
        stdout.write(dim(`\n  ↳ ${event.tool}${event.detail ? `: ${event.detail}` : ""}\n`));
      } else if (event.type === "step_done" && typeof event.stepIndex === "number") {
        completedSteps.add(event.stepIndex);
      } else if (event.type === "environment_proposed" && event.proposal) {
        proposal = event.proposal;
      } else if (event.type === "plan_updated" && event.openingContent) {
        updatedOpening = event.openingContent;
      } else if (event.type === "done" && event.content) {
        resolved = event.content;
      } else if (event.type === "error") {
        throw new Error(event.error ?? "Tutor turn failed.");
      } else if (event.type === "chunk" && event.content) {
        streamed += event.content;
      }
    },
  );

  // Wait for the server's final resolved content before printing. A plan-correction
  // tool may intentionally replace a verbose streamed draft with a concise action
  // summary; printing only the resolved result avoids showing both versions.
  stdout.write(
    `\n${green("Tutor")}\n\n${resolved ?? (streamed || "(No text response.)")}\n\n`,
  );
  if (proposal) await approveProposal(reader, api, projectId, proposal);
  return { ...(updatedOpening ? { updatedOpening } : {}) };
}

async function runNode(
  reader: Interface,
  api: ApiClient,
  projectId: number,
  node: LearningNode,
): Promise<"map" | "quit"> {
  let slides = await loadNode(api, projectId, node);
  let slideIndex = 0;
  const completedSteps = new Set<number>();
  await ensureStepDetail(api, projectId, node.id, slides[slideIndex]!);
  showSlide(slides[slideIndex]!, slideIndex, slides.length);
  showHelp();

  while (true) {
    const input = (await reader.question(cyan("node> "))).trim();
    if (!input) continue;
    if (input === "/quit") return "quit";
    if (input === "/esc") return "map";
    if (input === "/help") {
      showHelp();
      continue;
    }
    if (input === "/next" || input === "/back") {
      const delta = input === "/next" ? 1 : -1;
      const target = slideIndex + delta;
      if (target < 0 || target >= slides.length) {
        stdout.write(yellow(input === "/next" ? "This is the final step. Use /done when finished.\n" : "This is the overview.\n"));
        continue;
      }
      try {
        await ensureStepDetail(api, projectId, node.id, slides[target]!);
        slideIndex = target;
        showSlide(slides[slideIndex]!, slideIndex, slides.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stdout.write(red(`Could not open that step: ${message}\n`));
        stdout.write(dim("You are still on the current step and can retry.\n"));
      }
      continue;
    }
    if (input === "/done") {
      const answer = (await reader.question("Mark this node completed? [y/N] ")).trim();
      if (/^y(es)?$/i.test(answer)) {
        try {
          stdout.write(dim("Completing the node and updating its learning context…\n"));
          await api.completeNode(projectId, node.id);
          stdout.write(green("Node completed. Dependent nodes may now be available.\n"));
          return "map";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stdout.write(red(`Could not complete the node: ${message}\n`));
        }
      }
      continue;
    }
    if (input.startsWith("/")) {
      stdout.write(yellow("Unknown command. Use /help to see the command list.\n"));
      continue;
    }

    try {
      const result = await tutorTurn(
        reader,
        api,
        projectId,
        node,
        slides[slideIndex]!,
        input,
        completedSteps,
      );
      if (result.updatedOpening) {
        const freshSlides = parseSlides(result.updatedOpening);
        slides = freshSlides;
        slideIndex = Math.min(slideIndex, slides.length - 1);
        stdout.write(dim("The tutor updated this node's step plan.\n"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stdout.write(red(`Tutor turn failed: ${message}\n`));
      stdout.write(dim("The node is still open. You can retry or use another command.\n"));
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rawPath = args.find((argument) => !argument.startsWith("--"));
  const resumeLatest = args.includes("--resume-latest");
  if (!rawPath) {
    throw new Error(
      'Usage: pnpm pathforge:cli -- "C:\\path\\to\\project" [--resume-latest]',
    );
  }
  const workspacePath = resolve(rawPath);
  const info = await stat(workspacePath).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Project directory not found: ${workspacePath}`);

  const reader = createInterface({ input: stdin, output: stdout });
  let server: Awaited<ReturnType<typeof startEmbeddedApi>> | undefined;
  try {
    stdout.write(`\n${cyan("PathForge CLI")}\n${dim(`Workspace: ${workspacePath}`)}\n`);
    server = await startEmbeddedApi();
    stdout.write(dim(`AI access: ${server.mode === "byo" ? "your OpenRouter key" : server.mode === "free" ? "local free-tier proxy" : "not configured"}\n\n`));
    const api = new ApiClient(server.baseUrl);
    let project;
    let map;
    if (resumeLatest) {
      const projects = await api.listProjects();
      project = projects.at(-1);
      if (!project) throw new Error("There is no persisted project to resume.");
      stdout.write(dim(`Resuming latest project: ${project.title} (#${project.id})\n`));
      await api.attachWorkspace(project.id, workspacePath);
      map = await api.getMap(project.id).catch(() => api.generateMap(project!.id));
    } else {
      const title = await askRequired(reader, "Project name: ");
      const description = await askRequired(reader, "Project description: ");

      stdout.write(dim("\nCreating the project and attaching the local folder…\n"));
      project = await api.createProject(title, description);
      await api.attachWorkspace(project.id, workspacePath);
      stdout.write(dim("Generating the node map from the project description and current code…\n"));
      map = await api.generateMap(project.id);
    }

    while (true) {
      const selectable = showNodeMap(map.nodes);
      const input = (await reader.question(cyan("\nChoose a node number (/quit to exit): "))).trim();
      if (input === "/quit" || input === "/exit") break;
      const choice = Number.parseInt(input, 10);
      const node = selectable[choice - 1];
      if (!node || String(choice) !== input) {
        stdout.write(yellow("Choose one of the displayed node numbers.\n"));
        continue;
      }
      let outcome: "map" | "quit";
      try {
        outcome = await runNode(reader, api, project.id, node);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stdout.write(red(`Could not open the node: ${message}\n`));
        outcome = "map";
      }
      if (outcome === "quit") break;
      map = await api.getMap(project.id);
    }
  } finally {
    reader.close();
    await server?.close().catch(() => undefined);
  }
}

main()
  .then(() => {
    // PGlite owns a background worker that remains alive after the HTTP listener
    // closes. The CLI has already completed all graceful cleanup at this point,
    // so explicitly end the terminal process instead of leaving `/quit` hanging.
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n${red(`PathForge CLI failed: ${message}`)}\n`);
    process.exit(1);
  });
