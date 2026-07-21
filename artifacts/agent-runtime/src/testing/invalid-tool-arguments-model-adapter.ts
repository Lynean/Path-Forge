import type { AgentDecision, ModelTurnContext } from "../contracts";
import type { ModelAdapter } from "../model/model-adapter";

/** A deliberately incorrect model used to prove the harness blocks unsafe calls. */
export class InvalidToolArgumentsModelAdapter implements ModelAdapter {
  async decide(_context: ModelTurnContext): Promise<AgentDecision> {
    return {
      type: "tool_call",
      call: {
        id: "invalid-arguments-call",
        name: "inspect_project",
        arguments: { projectId: "not-a-number" },
      },
    };
  }
}
