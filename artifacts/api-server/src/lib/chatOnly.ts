// Pure-chat web mode: the tutoring experience (plan, node map, steps, chat)
// works exactly the same, but the folder/command/Docker/WASM harness is disabled
// entirely. Enabled with PATHFORGE_CHAT_ONLY=1. Used to serve a browser-only
// version with no code-execution surface: the chat always runs the legacy direct
// tutor, map/step generation ignore any attached folder, and the workspace /
// environment / runtime endpoints are not mounted.
export const isChatOnlyMode = process.env.PATHFORGE_CHAT_ONLY === "1";
