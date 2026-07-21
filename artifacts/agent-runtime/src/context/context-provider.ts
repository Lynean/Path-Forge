import type { AgentContextDocuments, AgentTurnInput } from "../contracts";

export interface AgentContextProvider {
  load(input: AgentTurnInput): Promise<AgentContextDocuments>;
}

export class EmptyContextProvider implements AgentContextProvider {
  async load(_input: AgentTurnInput): Promise<AgentContextDocuments> {
    return { soul: "", user: "", project: "" };
  }
}

export class StaticContextProvider implements AgentContextProvider {
  constructor(private readonly documents: AgentContextDocuments) {}

  async load(_input: AgentTurnInput): Promise<AgentContextDocuments> {
    return { ...this.documents };
  }
}
