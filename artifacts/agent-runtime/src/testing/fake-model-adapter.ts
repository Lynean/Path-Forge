import type { AgentDecision, ModelTurnContext } from "../contracts";
import type { ModelAdapter } from "../model/model-adapter";

export class FakeTutorModelAdapter implements ModelAdapter {
  async decide(context: ModelTurnContext): Promise<AgentDecision> {
    const explicitlyRequestsCommand =
      /\bplease\s+run\b|\brun\s+(?:pnpm|npm)\b/i.test(context.input.userMessage) &&
      context.tools.some((tool) => tool.name === "run_command");
    const needsInspection =
      explicitlyRequestsCommand || /test|build|error|fail|code/i.test(context.input.userMessage);
    const inspection = context.observations.find(
      (observation) => observation.tool === "inspect_project",
    );
    const commandObservation = context.observations.find(
      (observation) => observation.tool === "run_command",
    );

    if (needsInspection && !inspection) {
      return {
        type: "tool_call",
        call: {
          id: `fake-inspection-${context.turn}`,
          name: "inspect_project",
          arguments: {},
        },
      };
    }

    if (explicitlyRequestsCommand && inspection && !commandObservation) {
      const script = /typecheck/i.test(context.input.userMessage)
        ? "typecheck"
        : /build/i.test(context.input.userMessage)
          ? "build"
          : "test";
      return {
        type: "tool_call",
        call: {
          id: `fake-command-${context.turn}`,
          name: "run_command",
          arguments: { command: "pnpm", arguments: ["run", script], workingDirectory: "." },
        },
      };
    }

    if (commandObservation) {
      return {
        type: "final",
        response: `I ran the requested command in the Docker sandbox. The structured result was: ${JSON.stringify(commandObservation.output)}`,
        proposedActions: [
          { type: "none", reason: "The sandbox command supplied direct execution evidence." },
        ],
      };
    }

    if (inspection) {
      return {
        type: "final",
        response:
          "I inspected the project before answering, so I now have local structure evidence. The next safe step is to run the project test command in a sandbox.",
        proposedActions: [
          {
            type: "none",
            reason: "Inspection alone is not enough evidence to change the learning plan.",
          },
        ],
      };
    }

    return {
      type: "final",
      response: `Let us work through ${context.input.currentNode.title} one small step at a time in ${context.input.preferredLanguage ?? "your preferred language"}.`,
      proposedActions: [
        {
          type: "none",
          reason: "The learner asked for an explanation, not a plan mutation.",
        },
      ],
    };
  }
}
