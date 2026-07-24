import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentDesktopApi,
  CancelRunRequest,
  CancelRunResult,
  ConversationState,
  DesktopRunRequest,
  DesktopRunEvent,
  DesktopRunResult,
  OpenRouterKeyStatus,
  RuntimeStatus,
  WorkspaceSelection,
} from "../shared/contracts";

const api: AgentDesktopApi = {
  selectWorkspace: () =>
    ipcRenderer.invoke("agent-desktop:select-workspace") as Promise<WorkspaceSelection | null>,
  getRuntimeStatus: () =>
    ipcRenderer.invoke("agent-desktop:get-runtime-status") as Promise<RuntimeStatus>,
  getOpenRouterStatus: () =>
    ipcRenderer.invoke("agent-desktop:get-openrouter-status") as Promise<OpenRouterKeyStatus>,
  setOpenRouterKey: (apiKey: string) =>
    ipcRenderer.invoke("agent-desktop:set-openrouter-key", apiKey) as Promise<OpenRouterKeyStatus>,
  clearOpenRouterKey: () =>
    ipcRenderer.invoke("agent-desktop:clear-openrouter-key") as Promise<OpenRouterKeyStatus>,
  getConversation: () =>
    ipcRenderer.invoke("agent-desktop:get-conversation") as Promise<ConversationState>,
  clearConversation: () =>
    ipcRenderer.invoke("agent-desktop:clear-conversation") as Promise<ConversationState>,
  clearDependencyCache: () =>
    ipcRenderer.invoke("agent-desktop:clear-dependency-cache") as Promise<RuntimeStatus>,
  onRunEvent: (listener: (event: DesktopRunEvent) => void) => {
    ipcRenderer.on("agent-desktop:run-event", (_event, payload: DesktopRunEvent) => {
      listener(payload);
    });
  },
  removeRunEventListeners: () => {
    ipcRenderer.removeAllListeners("agent-desktop:run-event");
  },
  runTurn: (request: DesktopRunRequest) =>
    ipcRenderer.invoke("agent-desktop:run-turn", request) as Promise<DesktopRunResult>,
  cancelRun: (request: CancelRunRequest) =>
    ipcRenderer.invoke("agent-desktop:cancel-run", request) as Promise<CancelRunResult>,
};

contextBridge.exposeInMainWorld("agentDesktop", api);
