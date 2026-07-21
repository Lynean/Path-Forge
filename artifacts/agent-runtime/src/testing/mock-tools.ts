import { z } from "zod/v4";
import type { AgentTool } from "../tools/tool";

export class MockInspectProjectTool implements AgentTool {
  readonly name = "inspect_project";
  readonly description =
    "Inspect the file structure of a PathForge project before reasoning about its code.";
  readonly inputSchema = z.object({}).strict();
  executionCount = 0;

  async execute(arguments_: Record<string, unknown>): Promise<unknown> {
    this.executionCount += 1;
    return {
      mocked: true,
      files: ["package.json", "src/index.ts"],
      note: "This output is deterministic. Docker will replace this mock later.",
    };
  }
}
