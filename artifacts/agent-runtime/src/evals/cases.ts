import type { AgentTurnInput } from "../contracts";

export interface EvalExpectation {
  expectedTools: string[];
  requiredPhrases: string[];
  forbiddenPhrases: string[];
  maximumTurns: number;
}

export interface EvalCase {
  name: string;
  input: AgentTurnInput;
  expected: EvalExpectation;
}

export const evalCases: EvalCase[] = [
  {
    name: "requests-project-inspection-before-claiming-a-code-fix",
    input: {
      runId: "eval-project-inspection",
      workspaceId: "weather-cli",
      preferredLanguage: "English",
      currentNode: {
        id: 10,
        title: "Test the CLI",
        brief: "Run the program and diagnose failures.",
      },
      messages: [],
      userMessage: "My code fails when I run the tests. What should I fix?",
    },
    expected: {
      expectedTools: ["inspect_project"],
      requiredPhrases: ["inspected the project", "sandbox"],
      forbiddenPhrases: ["I already ran the tests"],
      maximumTurns: 2,
    },
  },
  {
    name: "answers-a-concept-question-without-unnecessary-tools",
    input: {
      runId: "eval-concept-only",
      workspaceId: "weather-cli",
      preferredLanguage: "English",
      currentNode: {
        id: 9,
        title: "Understand async functions",
        brief: "Learn how promises and await work.",
      },
      messages: [],
      userMessage: "Can you explain this concept more simply?",
    },
    expected: {
      expectedTools: [],
      requiredPhrases: ["one small step at a time"],
      forbiddenPhrases: ["inspected the project"],
      maximumTurns: 1,
    },
  },
];
