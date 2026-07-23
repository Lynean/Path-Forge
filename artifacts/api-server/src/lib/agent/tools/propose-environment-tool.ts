import { z } from "zod/v4";
import type { AgentTool } from "@workspace/agent-runtime";

const proposeEnvironmentSchema = z
  .object({
    language: z.string().min(1).describe("Language/ecosystem, e.g. rust, go, java, cpp"),
    baseImage: z.string().min(1).describe("A Docker base image + tag, e.g. rust:1.83-slim"),
    setupCommands: z.array(z.string().min(1)).optional().describe("Setup/build steps, e.g. apt/install/cargo commands"),
    runCommand: z.string().optional().describe("How to run or test the project"),
    reason: z.string().min(1).describe("Why this environment fits the project"),
    dockerfile: z.string().optional().describe("Optional full Dockerfile"),
  })
  .strict();

/**
 * Lets the agent PROPOSE a Docker environment for a project the built-in
 * Node/Python sandboxes don't cover (Go, Rust, Java, C/C++, or anything needing
 * system packages). It only records/echoes the proposal — nothing is built or
 * run automatically. The learner (the trust authority on their own machine)
 * reviews the recipe and applies it; a later phase adds an approve-and-build
 * flow. `execute` validates and returns the proposal so it is recorded and
 * surfaced.
 */
export class ProposeEnvironmentTool implements AgentTool {
  readonly name = "propose_environment";
  readonly description =
    "Propose a Docker environment for a project that can't run in the built-in Node/Python sandboxes (e.g. Go, Rust, Java, C/C++, or a project needing extra system packages). Give a base image, setup/build commands, a run/test command, and why it fits. This is a SUGGESTION shown to the learner — it is NOT built or run automatically. Prefer a specific, pinned base image (e.g. rust:1.83-slim), not 'latest'.";
  readonly inputSchema = proposeEnvironmentSchema as unknown as z.ZodType<Record<string, unknown>>;

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    const proposal = proposeEnvironmentSchema.parse(arguments_);
    return { recorded: true, proposedEnvironment: proposal };
  }
}
