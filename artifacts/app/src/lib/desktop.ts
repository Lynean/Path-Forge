// Typed access to the Electron desktop bridge injected by the agent-desktop
// shell's preload. Absent in a normal browser (returns null).
export interface DesktopWorkspaceSelection {
  id: string;
  name: string;
  path: string;
}

interface DesktopBridge {
  selectWorkspace(): Promise<DesktopWorkspaceSelection | null>;
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { agentDesktop?: DesktopBridge }).agentDesktop ?? null;
}
