import { z } from "zod/v4";

export const agentMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const agentTurnInputSchema = z.object({
  runId: z.string().min(1),
  workspaceId: z.string().min(1),
  preferredLanguage: z.string().min(1).nullable(),
  currentNode: z.object({
    id: z.number().int().positive(),
    title: z.string().min(1),
    brief: z.string().optional(),
  }),
  messages: z.array(agentMessageSchema),
  userMessage: z.string().min(1),
});

export const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

export const agentDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_call"),
    call: toolCallSchema,
  }),
  z.object({
    type: z.literal("final"),
    response: z.string().min(1),
    proposedActions: z.array(
      z.object({
        type: z.enum(["none", "update_steps", "spawn_node", "revise_plan"]),
        reason: z.string(),
      }),
    ),
  }),
]);

export const agentResultSchema = z.object({
  status: z.literal("completed"),
  runId: z.string(),
  response: z.string(),
  proposedActions: z.array(
    z.object({
      type: z.enum(["none", "update_steps", "spawn_node", "revise_plan"]),
      reason: z.string(),
    }),
  ),
  toolCalls: z.array(z.string()),
  turns: z.number().int().positive(),
});

export type AgentTurnInput = z.infer<typeof agentTurnInputSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentDecision = z.infer<typeof agentDecisionSchema>;
export type AgentResult = z.infer<typeof agentResultSchema>;

export const agentFailureStatusSchema = z.enum([
  "failed",
  "cancelled",
  "timed_out",
  "budget_exceeded",
  "policy_rejected",
]);

export const agentFailureCodeSchema = z.enum([
  "INVALID_INPUT",
  "RUN_ALREADY_ACTIVE",
  "UNKNOWN_TOOL",
  "INVALID_TOOL_ARGUMENTS",
  "REPEATED_TOOL_CALL",
  "MAX_MODEL_TURNS_EXCEEDED",
  "MAX_TOOL_CALLS_EXCEEDED",
  "RUN_TIMEOUT",
  "TOOL_TIMEOUT",
  "CANCELLED",
  "HARNESS_ERROR",
]);

export type AgentFailureStatus = z.infer<typeof agentFailureStatusSchema>;
export type AgentFailureCode = z.infer<typeof agentFailureCodeSchema>;

export interface AgentContextDocuments {
  soul: string;
  user: string;
  project: string;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AgentEvent =
  | { type: "run_started"; runId: string }
  | { type: "model_turn_started"; turn: number }
  | { type: "tool_started"; tool: string; arguments: Record<string, unknown> }
  | {
      type: "tool_progress";
      tool: string;
      stage: "sandbox_preparing" | "sandbox_ready" | "command_running";
      message: string;
    }
  | { type: "tool_completed"; tool: string; output: unknown }
  | { type: "tool_rejected"; tool: string; code: string; message: string }
  | { type: "text_delta"; content: string }
  | { type: "completed"; result: AgentResult }
  | {
      type: "failed";
      status: AgentFailureStatus;
      code: AgentFailureCode;
      message: string;
    };

export interface ToolObservation {
  toolCallId: string;
  tool: string;
  arguments: Record<string, unknown>;
  output: unknown;
}

export interface ModelTurnContext {
  input: AgentTurnInput;
  documents: AgentContextDocuments;
  tools: ModelToolDefinition[];
  turn: number;
  observations: ToolObservation[];
  signal: AbortSignal;
}
