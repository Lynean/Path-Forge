import type { AgentDecision, ModelTurnContext } from "../contracts";
import type { ModelAdapter } from "./model-adapter";
import type {
  CompletionGateway,
  CompletionRequest,
  CompletionResponse,
} from "./completion-gateway";
import type { ModelDecisionStreamEvent } from "./model-adapter";
import { buildCompletionMessages } from "./prompt-builder";

export interface OpenRouterModelAdapterOptions {
  gateway: CompletionGateway;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  const parsed = JSON.parse(rawArguments) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The model returned tool arguments that were not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export class OpenRouterModelAdapter implements ModelAdapter {
  constructor(private readonly options: OpenRouterModelAdapterOptions) {}

  private request(context: ModelTurnContext): CompletionRequest {
    return {
      model: this.options.model,
      messages: buildCompletionMessages(context),
      tools: context.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      maxTokens: this.options.maxTokens ?? 2_048,
      temperature: this.options.temperature ?? 0.2,
      parallelToolCalls: false,
      signal: context.signal,
    };
  }

  private decisionFromResponse(response: CompletionResponse): AgentDecision {
    const toolCall = response.toolCalls[0];
    if (toolCall) {
      return {
        type: "tool_call",
        call: {
          id: toolCall.id,
          name: toolCall.name,
          arguments: parseToolArguments(toolCall.arguments),
        },
      };
    }

    const content = response.content?.trim();
    if (!content) throw new Error("The model returned neither a tool call nor an answer");

    return {
      type: "final",
      response: content,
      proposedActions: [
        {
          type: "none",
          reason: "This desktop milestone supports tutoring and read-only inspection only.",
        },
      ],
    };
  }

  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    return this.decisionFromResponse(
      await this.options.gateway.complete(this.request(context)),
    );
  }

  async *streamDecision(context: ModelTurnContext): AsyncIterable<ModelDecisionStreamEvent> {
    if (!this.options.gateway.stream) {
      yield { type: "decision", decision: await this.decide(context) };
      return;
    }

    let completed = false;
    for await (const event of this.options.gateway.stream(this.request(context))) {
      if (event.type === "text_delta") {
        yield event;
      } else {
        completed = true;
        yield { type: "decision", decision: this.decisionFromResponse(event.response) };
      }
    }
    if (!completed) throw new Error("The model stream ended without a completed response");
  }
}
