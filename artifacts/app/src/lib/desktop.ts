// Typed access to the Electron desktop bridge injected by the agent-desktop
// shell's preload. Absent in a normal browser (returns null).
export interface DesktopWorkspaceSelection {
  id: string;
  name: string;
  path: string;
}

export interface OpenRouterKeyStatus {
  configured: boolean;
}

interface DesktopBridge {
  selectWorkspace(): Promise<DesktopWorkspaceSelection | null>;
  // BYO OpenRouter key (desktop only). The main process persists it encrypted and
  // pushes it to the local backend; the renderer never stores the key.
  getOpenRouterStatus?(): Promise<OpenRouterKeyStatus>;
  setOpenRouterKey?(apiKey: string): Promise<OpenRouterKeyStatus>;
  clearOpenRouterKey?(): Promise<OpenRouterKeyStatus>;
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { agentDesktop?: DesktopBridge }).agentDesktop ?? null;
}
