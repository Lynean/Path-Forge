import type { AgentDesktopApi } from "../../shared/contracts";

declare global {
  interface Window {
    agentDesktop: AgentDesktopApi;
  }
}

export {};
