export interface SseEvent {
  type?: string;
  content?: string;
  error?: string;
  message?: string;
  tool?: string;
  detail?: string;
  stepIndex?: number;
  openingContent?: string;
  proposal?: EnvironmentProposal;
  nodeId?: number;
  title?: string;
}

export interface EnvironmentProposal {
  language?: string;
  baseImage?: string;
  setupCommands?: string[];
  runCommand?: string;
  reason?: string;
  dockerfile?: string;
}

export async function consumeSse(
  response: Response,
  onEvent: (event: SseEvent) => void | Promise<void>,
): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      message = parsed.error ?? text;
    } catch {
      // Keep the response text.
    }
    throw new Error(message || `Request failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("The server returned no event stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processLine = async (line: string): Promise<void> => {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") {
      if (payload === "[DONE]") await onEvent({ type: "done" });
      return;
    }
    try {
      await onEvent(JSON.parse(payload) as SseEvent);
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) await processLine(line);
    if (done) break;
  }
  if (buffer) await processLine(buffer);
}
