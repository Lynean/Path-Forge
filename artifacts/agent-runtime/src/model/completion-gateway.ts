export interface CompletionTextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionAssistantToolMessage {
  role: "assistant";
  content: string | null;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface CompletionToolResultMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export type CompletionMessage =
  | CompletionTextMessage
  | CompletionAssistantToolMessage
  | CompletionToolResultMessage;

export interface CompletionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionRequest {
  model: string;
  messages: CompletionMessage[];
  tools: CompletionTool[];
  maxTokens: number;
  temperature: number;
  parallelToolCalls: false;
  signal: AbortSignal;
}

export interface CompletionToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CompletionResponse {
  content: string | null;
  toolCalls: CompletionToolCall[];
}

export type CompletionStreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "completed"; response: CompletionResponse };

export interface CompletionGateway {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream?(request: CompletionRequest): AsyncIterable<CompletionStreamEvent>;
}
