import type { EnvironmentProposal, SseEvent } from "./sse";
import { consumeSse } from "./sse";

export interface Project {
  id: number;
  title: string;
  ideaPrompt: string;
  status?: "draft" | "active" | "completed";
  updatedAt?: string;
}

export interface LearningNode {
  id: number;
  title: string;
  brief: string;
  status: "locked" | "available" | "completed";
  summary?: string | null;
}

export interface NodeMap {
  projectId: number;
  nodes: LearningNode[];
  edges: Array<{ fromNodeId: number; toNodeId: number }>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  private async json<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  createProject(title: string, ideaPrompt: string): Promise<Project> {
    return this.json("/projects", {
      method: "POST",
      body: JSON.stringify({ title, ideaPrompt }),
    });
  }

  listProjects(): Promise<Project[]> {
    return this.json("/projects");
  }

  attachWorkspace(projectId: number, workspacePath: string): Promise<void> {
    return this.json(`/projects/${projectId}/workspace`, {
      method: "PUT",
      body: JSON.stringify({ path: workspacePath }),
    });
  }

  generateMap(projectId: number): Promise<NodeMap> {
    return this.json(`/projects/${projectId}/generate-map`, { method: "POST" });
  }

  getMap(projectId: number): Promise<NodeMap> {
    return this.json(`/projects/${projectId}/map`);
  }

  async getChat(projectId: number, nodeId: number): Promise<ChatMessage[]> {
    const result = await this.json<{ messages: ChatMessage[] }>(
      `/projects/${projectId}/nodes/${nodeId}/chat`,
    );
    return result.messages;
  }

  streamOpening(
    projectId: number,
    nodeId: number,
    onEvent: (event: SseEvent) => void | Promise<void>,
  ): Promise<void> {
    return fetch(
      `${this.baseUrl}/api/projects/${projectId}/nodes/${nodeId}/opening-message`,
      { method: "POST" },
    ).then((response) => consumeSse(response, onEvent));
  }

  streamStepDetail(
    projectId: number,
    nodeId: number,
    input: {
      stepIndex: number;
      stepTitle: string;
      stepBrief: string;
      stepNote?: string;
    },
    onEvent: (event: SseEvent) => void | Promise<void>,
  ): Promise<void> {
    return fetch(
      `${this.baseUrl}/api/projects/${projectId}/nodes/${nodeId}/step-detail`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    ).then((response) => consumeSse(response, onEvent));
  }

  streamChat(
    projectId: number,
    nodeId: number,
    content: string,
    completedStepIndices: number[],
    onEvent: (event: SseEvent) => void | Promise<void>,
  ): Promise<void> {
    return fetch(
      `${this.baseUrl}/api/projects/${projectId}/nodes/${nodeId}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, completedStepIndices }),
      },
    ).then((response) => consumeSse(response, onEvent));
  }

  approveEnvironment(
    projectId: number,
    proposal: EnvironmentProposal,
  ): Promise<void> {
    if (!proposal.baseImage || !proposal.runCommand) {
      throw new Error("The proposed environment is incomplete.");
    }
    return this.json(`/projects/${projectId}/environment`, {
      method: "PUT",
      body: JSON.stringify({
        ...(proposal.language ? { language: proposal.language } : {}),
        baseImage: proposal.baseImage,
        setupCommands: proposal.setupCommands ?? [],
        runCommand: proposal.runCommand,
        ...(proposal.dockerfile ? { dockerfile: proposal.dockerfile } : {}),
      }),
    });
  }

  completeNode(projectId: number, nodeId: number): Promise<NodeMap> {
    return this.json(`/projects/${projectId}/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "completed" }),
    });
  }
}
