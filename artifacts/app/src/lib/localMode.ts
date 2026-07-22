// Fully-local desktop mode: no Clerk login, single on-device user. Detected
// either by an explicit build flag (VITE_LOCAL_MODE=1) or at runtime by the
// presence of the Electron desktop bridge injected by the agent-desktop shell.
export const isLocalMode =
  import.meta.env.VITE_LOCAL_MODE === "1" ||
  (typeof window !== "undefined" && Boolean((window as unknown as { agentDesktop?: unknown }).agentDesktop));
