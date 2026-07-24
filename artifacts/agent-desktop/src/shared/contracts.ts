import type { AgentEvent, AgentMessage } from "@workspace/agent-runtime";
import { z } from "zod/v4";

export const desktopRunRequestSchema = z.object({
  clientRunId: z.string().uuid(),
  modelMode: z.enum(["demo", "openrouter"]),
  model: z.string().trim().min(1),
  preferredLanguage: z.string().trim().min(1).nullable(),
  currentNodeTitle: z.string().trim().min(1),
  userMessage: z.string().trim().min(1),
});

export type DesktopRunRequest = z.infer<typeof desktopRunRequestSchema>;

export const cancelRunRequestSchema = z.object({
  clientRunId: z.string().uuid(),
});

export type CancelRunRequest = z.infer<typeof cancelRunRequestSchema>;

export interface CancelRunResult {
  accepted: boolean;
}

export interface WorkspaceSelection {
  id: string;
  name: string;
  path: string;
}

export interface DesktopRunResult {
  events: AgentEvent[];
  conversation: AgentMessage[];
}

export interface ConversationState {
  messages: AgentMessage[];
}

export interface RuntimeStatus {
  openRouterConfigured: boolean;
  defaultModel: string;
  dockerReady: boolean;
  dockerMessage: string;
  dependencyCacheEntries: number;
  dependencyCacheBytes: number;
}

export interface DesktopRunEvent {
  clientRunId: string;
  event: AgentEvent;
}

export interface OpenRouterKeyStatus {
  configured: boolean;
}

export interface AgentDesktopApi {
  selectWorkspace(): Promise<WorkspaceSelection | null>;
  getRuntimeStatus(): Promise<RuntimeStatus>;
  // BYO OpenRouter key: the main process persists it (encrypted, safeStorage) and
  // pushes it to the local backend; the key never persists in the renderer.
  getOpenRouterStatus(): Promise<OpenRouterKeyStatus>;
  setOpenRouterKey(apiKey: string): Promise<OpenRouterKeyStatus>;
  clearOpenRouterKey(): Promise<OpenRouterKeyStatus>;
  getConversation(): Promise<ConversationState>;
  clearConversation(): Promise<ConversationState>;
  clearDependencyCache(): Promise<RuntimeStatus>;
  onRunEvent(listener: (event: DesktopRunEvent) => void): void;
  removeRunEventListeners(): void;
  runTurn(request: DesktopRunRequest): Promise<DesktopRunResult>;
  cancelRun(request: CancelRunRequest): Promise<CancelRunResult>;
}
