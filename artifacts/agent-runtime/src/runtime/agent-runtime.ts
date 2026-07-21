import type { AgentEvent, AgentTurnInput } from "../contracts";

export interface AgentRuntime {
  runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
