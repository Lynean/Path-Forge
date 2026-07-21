import { z } from "zod/v4";
import type { ModelToolDefinition } from "../contracts";

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  execute(arguments_: Record<string, unknown>, context?: AgentToolContext): Promise<unknown>;
  executeStream?(
    arguments_: Record<string, unknown>,
    context: AgentToolContext,
  ): AsyncIterable<AgentToolStreamEvent>;
  /** Advances tool-history revision when this result changes later tool evidence. */
  invalidatesPriorToolResults?(output: unknown): boolean;
  finishRun?(runId: string): Promise<void>;
}

export type AgentToolStreamEvent =
  | {
      type: "progress";
      stage: "sandbox_preparing" | "sandbox_ready" | "command_running";
      message: string;
    }
  | { type: "result"; output: unknown };

export interface AgentToolContext {
  runId: string;
  signal: AbortSignal;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate agent tool: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  definitions(): ModelToolDefinition[] {
    return this.list().map((tool) => {
      const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
      delete schema["$schema"];
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: schema,
      };
    });
  }

  async finishRun(runId: string): Promise<void> {
    const results = await Promise.allSettled(
      this.list().map((tool) => tool.finishRun?.(runId) ?? Promise.resolve()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to clean up tools for run ${runId}`);
    }
  }
}
