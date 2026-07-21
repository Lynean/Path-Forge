import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, AgentMessage } from "@workspace/agent-runtime";
import type { RuntimeStatus, WorkspaceSelection } from "../../shared/contracts";

function shortenTrace(value: string, maximum = 2_500): string {
  if (value.length <= maximum) return value;
  const marker = "\n… output shortened in the UI; showing the beginning and the useful ending …\n";
  const contentLimit = maximum - marker.length;
  const headLimit = Math.floor(contentLimit / 3);
  return `${value.slice(0, headLimit)}${marker}${value.slice(-(contentLimit - headLimit))}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function eventLabel(event: AgentEvent): string {
  switch (event.type) {
    case "run_started":
      return "Run started";
    case "model_turn_started":
      return `Model turn ${event.turn}`;
    case "tool_started":
      return `Tool requested · ${event.tool}`;
    case "tool_progress":
      return `Sandbox · ${event.stage.replaceAll("_", " ")}`;
    case "tool_completed":
      return `Tool completed · ${event.tool}`;
    case "tool_rejected":
      return `Tool blocked · ${event.tool}`;
    case "text_delta":
      return "Answer prepared";
    case "completed":
      return "Run completed";
    case "failed":
      return `Run failed · ${event.code}`;
  }
}

function eventDetails(event: AgentEvent): string | null {
  switch (event.type) {
    case "run_started":
      return `Run ID: ${event.runId}`;
    case "model_turn_started":
      return "The harness asks the model what to do next.";
    case "tool_started":
      return JSON.stringify(event.arguments, null, 2);
    case "tool_progress":
      return event.message;
    case "tool_completed": {
      const serialized = JSON.stringify(event.output, null, 2);
      return shortenTrace(serialized);
    }
    case "tool_rejected":
      return `${event.code}: ${event.message}`;
    case "text_delta":
      return event.content;
    case "completed":
      return `${event.result.turns} model turn(s) · ${event.result.toolCalls.length} tool call(s)`;
    case "failed":
      return event.message;
  }
}

function appendEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  const previous = events.at(-1);
  if (event.type === "text_delta" && previous?.type === "text_delta") {
    return [
      ...events.slice(0, -1),
      { type: "text_delta", content: previous.content + event.content },
    ];
  }
  return [...events, event];
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSelection | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [modelMode, setModelMode] = useState<"demo" | "openrouter">("demo");
  const [model, setModel] = useState("google/gemini-3.1-flash-lite");
  const [preferredLanguage, setPreferredLanguage] = useState("English");
  const [currentNodeTitle, setCurrentNodeTitle] = useState("Test the project");
  const [userMessage, setUserMessage] = useState(
    "My code fails when I run the tests. Inspect the project before suggesting what to do.",
  );
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [conversation, setConversation] = useState<AgentMessage[]>([]);
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const activeRunId = useRef<string | null>(null);

  useEffect(() => {
    void window.agentDesktop
      .getRuntimeStatus()
      .then((status) => {
        setRuntimeStatus(status);
        setModel(status.defaultModel);
        if (status.openRouterConfigured) setModelMode("openrouter");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not read runtime status");
      });
  }, []);

  useEffect(() => {
    window.agentDesktop.onRunEvent(({ clientRunId, event }) => {
      if (clientRunId !== activeRunId.current) return;
      setEvents((current) => appendEvent(current, event));
      if (event.type === "text_delta") {
        setStreamingAnswer((current) => current + event.content);
      }
    });
    return () => window.agentDesktop.removeRunEventListeners();
  }, []);

  const finalAnswer = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === "completed") return event.result.response;
    }
    return null;
  }, [events]);
  const displayedAnswer = finalAnswer ?? (streamingAnswer || null);

  async function chooseWorkspace() {
    setError(null);
    try {
      const selection = await window.agentDesktop.selectWorkspace();
      if (selection) {
        setWorkspace(selection);
        setEvents([]);
        setStreamingAnswer("");
        const [savedConversation, latestRuntimeStatus] = await Promise.all([
          window.agentDesktop.getConversation(),
          window.agentDesktop.getRuntimeStatus(),
        ]);
        setConversation(savedConversation.messages);
        setRuntimeStatus(latestRuntimeStatus);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not select the workspace");
    }
  }

  async function runAgent() {
    if (!workspace) {
      setError("Choose a project folder first.");
      return;
    }

    setError(null);
    setEvents([]);
    setStreamingAnswer("");
    setIsRunning(true);
    const clientRunId = crypto.randomUUID();
    activeRunId.current = clientRunId;
    try {
      const result = await window.agentDesktop.runTurn({
        clientRunId,
        modelMode,
        model,
        preferredLanguage: preferredLanguage.trim() || null,
        currentNodeTitle,
        userMessage,
      });
      setEvents(result.events);
      setConversation(result.conversation);
      setRuntimeStatus(await window.agentDesktop.getRuntimeStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The agent run failed");
    } finally {
      activeRunId.current = null;
      setIsRunning(false);
    }
  }

  async function cancelAgent() {
    const clientRunId = activeRunId.current;
    if (!clientRunId) return;
    setError(null);
    try {
      const result = await window.agentDesktop.cancelRun({ clientRunId });
      if (!result.accepted) setError("The run finished before cancellation reached it.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel the agent run");
    }
  }

  async function clearSavedConversation() {
    setError(null);
    try {
      const state = await window.agentDesktop.clearConversation();
      setConversation(state.messages);
      setEvents([]);
      setStreamingAnswer("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not clear the conversation");
    }
  }

  async function clearDependencyCache() {
    setError(null);
    setIsClearingCache(true);
    try {
      setRuntimeStatus(await window.agentDesktop.clearDependencyCache());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not clear the dependency cache");
    } finally {
      setIsClearingCache(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">BUILDWEEK · LOCAL AGENT RUNTIME</p>
          <h1>PathForge Agent Lab</h1>
          <p className="lede">
            Select a project, send one learning question, and watch the harness decide when it
            needs local evidence.
          </p>
        </div>
        <div className={`safety-badge ${runtimeStatus?.dockerReady ? "safety-badge-live" : ""}`}>
          <span className="status-dot" />
          {runtimeStatus?.dockerReady
            ? `${modelMode === "openrouter" ? "Live OpenRouter" : "Demo model"} · Docker ready`
            : "Docker sandbox unavailable"}
        </div>
      </header>

      <section className="workspace-card">
        <div className="step-number">01</div>
        <div className="workspace-copy">
          <span className="section-kicker">Approved workspace</span>
          <strong>{workspace?.name ?? "No project selected"}</strong>
          <span className="workspace-path">
            {workspace?.path ?? "The agent cannot inspect files until you choose a folder."}
          </span>
        </div>
        <button className="secondary-button" type="button" disabled={isRunning} onClick={chooseWorkspace}>
          {workspace ? "Change folder" : "Choose folder"}
        </button>
      </section>

      <div className="lab-grid">
        <section className="panel setup-panel">
          <div className="panel-heading">
            <div className="step-number">02</div>
            <div>
              <span className="section-kicker">Runtime input</span>
              <h2>Ask the tutor</h2>
            </div>
          </div>

          <label>
            Model runtime
            <div className="mode-grid">
              <button
                className={modelMode === "openrouter" ? "mode-option mode-option-active" : "mode-option"}
                type="button"
                disabled={!runtimeStatus?.openRouterConfigured}
                onClick={() => setModelMode("openrouter")}
              >
                <strong>OpenRouter</strong>
                <span>
                  {runtimeStatus?.openRouterConfigured
                    ? "Real model + protected Docker tools"
                    : "Add OPENROUTER_API_KEY to .env"}
                </span>
              </button>
              <button
                className={modelMode === "demo" ? "mode-option mode-option-active" : "mode-option"}
                type="button"
                onClick={() => setModelMode("demo")}
              >
                <strong>Demo</strong>
                <span>Deterministic model + real Docker sandbox</span>
              </button>
            </div>
          </label>

          <label>
            Model ID
            <input
              value={model}
              disabled={modelMode === "demo"}
              onChange={(event) => setModel(event.target.value)}
              placeholder="google/gemini-3.1-flash-lite"
            />
          </label>

          <label>
            Preferred language
            <input
              value={preferredLanguage}
              onChange={(event) => setPreferredLanguage(event.target.value)}
              placeholder="English"
            />
          </label>

          <label>
            Current learning node
            <input
              value={currentNodeTitle}
              onChange={(event) => setCurrentNodeTitle(event.target.value)}
              placeholder="Test the project"
            />
          </label>

          <label>
            Message
            <textarea
              rows={7}
              value={userMessage}
              onChange={(event) => setUserMessage(event.target.value)}
            />
          </label>

          {error ? <div className="error-box">{error}</div> : null}

          <div className={runtimeStatus?.dockerReady ? "runtime-box runtime-box-ready" : "runtime-box"}>
            <strong>{runtimeStatus?.dockerReady ? "Docker ready" : "Docker required"}</strong>
            <span>{runtimeStatus?.dockerMessage ?? "Checking Docker and the sandbox image…"}</span>
            <div className="cache-row">
              <span>
                Dependency cache: {runtimeStatus?.dependencyCacheEntries ?? 0} image(s) · {formatBytes(runtimeStatus?.dependencyCacheBytes ?? 0)}
              </span>
              <button
                className="secondary-button cache-clear-button"
                type="button"
                disabled={
                  isRunning ||
                  isClearingCache ||
                  !runtimeStatus?.dockerReady ||
                  (runtimeStatus?.dependencyCacheEntries ?? 0) === 0
                }
                onClick={clearDependencyCache}
              >
                {isClearingCache ? "Clearing…" : "Clear cache"}
              </button>
            </div>
          </div>

          <div className="run-actions">
            <button
              className="primary-button"
              type="button"
              disabled={
                isRunning ||
                !runtimeStatus?.dockerReady ||
                !workspace ||
                !model.trim() ||
                !currentNodeTitle.trim() ||
                !userMessage.trim()
              }
              onClick={runAgent}
            >
              {isRunning ? "Running harness…" : "Run one agent turn"}
            </button>
            <button
              className="cancel-button"
              type="button"
              disabled={!isRunning}
              onClick={cancelAgent}
            >
              Cancel run
            </button>
          </div>

          <p className="helper-text">
            Project commands run in a copied Docker workspace. Your selected local folder remains unchanged.
          </p>
        </section>

        <section className="panel trace-panel">
          <div className="panel-heading">
            <div className="step-number">03</div>
            <div>
              <span className="section-kicker">Harness trace</span>
              <h2>See every decision</h2>
            </div>
          </div>

          {events.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">→</div>
              <strong>No run yet</strong>
              <span>Tool requests, validation, observations, and the final answer appear here.</span>
            </div>
          ) : (
            <ol className="timeline">
              {events.map((event, index) => (
                <li key={`${event.type}-${index}`} className={`event event-${event.type}`}>
                  <span className="event-index">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{eventLabel(event)}</strong>
                    {eventDetails(event) ? <pre>{eventDetails(event)}</pre> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {displayedAnswer ? (
        <section className="answer-card">
          <span className="section-kicker">
            {finalAnswer ? "Agent answer" : "Agent answer · streaming"}
          </span>
          <p>{displayedAnswer}</p>
        </section>
      ) : null}

      <section className="conversation-card">
        <div className="conversation-heading">
          <div>
            <span className="section-kicker">Workspace memory</span>
            <h2>Saved conversation</h2>
          </div>
          <button
            className="conversation-clear"
            type="button"
            disabled={!workspace || conversation.length === 0}
            onClick={clearSavedConversation}
          >
            Clear conversation
          </button>
        </div>
        {conversation.length === 0 ? (
          <p className="conversation-empty">
            Completed turns for this workspace will be restored the next time you select it.
          </p>
        ) : (
          <div className="conversation-list">
            {conversation.map((message, index) => (
              <article
                className={`conversation-message conversation-message-${message.role}`}
                key={`${message.role}-${index}`}
              >
                <span>{message.role === "user" ? "You" : "Agent"}</span>
                <p>{message.content}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
