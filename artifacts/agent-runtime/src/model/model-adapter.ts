import type { AgentDecision, ModelTurnContext } from "../contracts";

export type ModelDecisionStreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "decision"; decision: AgentDecision };

export interface ModelAdapter {
  decide(context: ModelTurnContext): Promise<AgentDecision>;
  streamDecision?(context: ModelTurnContext): AsyncIterable<ModelDecisionStreamEvent>;
}
