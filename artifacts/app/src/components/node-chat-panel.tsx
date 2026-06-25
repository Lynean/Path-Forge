import { useState, useRef, useEffect, useCallback } from "react";
import {
  useGetNodeChat,
  useUpdateNodeStatus,
  useGetProject,
  getGetNodeChatQueryKey,
  getGetNodeMapQueryKey,
  getGetProjectStatsQueryKey,
  getGetProjectQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  X,
  Send,
  CheckCircle,
  Loader2,
  Plus,
  Sparkles,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Node as ApiNode } from "@workspace/api-client-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const match = /language-(\w+)/.exec(className ?? "");
  const code = String(children ?? "").replace(/\n$/, "");
  if (match) {
    return (
      <SyntaxHighlighter
        style={vscDarkPlus as any}
        language={match[1]}
        PreTag="div"
        customStyle={{ borderRadius: "0.5rem", fontSize: "0.8rem", margin: "0.5rem 0" }}
      >
        {code}
      </SyntaxHighlighter>
    );
  }
  return (
    <code className="bg-black/30 text-primary font-mono text-xs px-1.5 py-0.5 rounded">
      {children}
    </code>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex gap-2.5", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-1">
          <Sparkles className="w-3 h-3 text-primary" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[86%] rounded-2xl px-3.5 py-2.5 text-sm",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-secondary text-secondary-foreground rounded-bl-sm"
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
        ) : (
          <div className="prose prose-sm prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-code:before:content-none prose-code:after:content-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ code: CodeBlock as any }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-2.5 justify-start">
      <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-1">
        <Sparkles className="w-3 h-3 text-primary" />
      </div>
      <div className="bg-secondary rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1 items-center h-4">
          <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

interface NodeChatPanelProps {
  projectId: number;
  node: ApiNode;
  onClose: () => void;
  onMapUpdate: () => void;
}

export function NodeChatPanel({ projectId, node, onClose, onMapUpdate }: NodeChatPanelProps) {
  const nodeId = node.id;
  const queryClient = useQueryClient();

  const [input, setInput] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [localMessagesLoaded, setLocalMessagesLoaded] = useState(false);
  const [openingInProgress, setOpeningInProgress] = useState(false);
  const [spawnTopic, setSpawnTopic] = useState("");
  const [showSpawnInput, setShowSpawnInput] = useState(false);
  const [isSpawning, setIsSpawning] = useState(false);
  const [completedSummary, setCompletedSummary] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const openingAbortRef = useRef<AbortController | null>(null);

  const { data: chatHistory, isLoading: chatLoading } = useGetNodeChat(projectId, nodeId, {
    query: {
      enabled: !!projectId && !!nodeId,
      queryKey: getGetNodeChatQueryKey(projectId, nodeId),
    },
  });

  const updateStatus = useUpdateNodeStatus({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetNodeMapQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        onMapUpdate();
        const updatedNode = data.nodes.find((n) => n.id === nodeId);
        if (updatedNode?.summary) {
          setCompletedSummary(updatedNode.summary);
        }
      },
    },
  });

  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  const generateOpeningMessage = useCallback(async () => {
    if (openingInProgress) return;
    setOpeningInProgress(true);
    setIsStreaming(true);
    setStreamingContent("");
    openingAbortRef.current = new AbortController();

    try {
      const res = await fetch(
        `${base}/api/projects/${projectId}/nodes/${nodeId}/opening-message`,
        {
          method: "POST",
          signal: openingAbortRef.current.signal,
        }
      );
      if (!res.ok || !res.body) {
        setOpeningInProgress(false);
        setIsStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                fullContent += parsed.content;
                setStreamingContent(fullContent);
              }
            } catch {}
          }
        }
      }

      if (fullContent) {
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: fullContent,
          createdAt: new Date().toISOString(),
        };
        setLocalMessages([assistantMsg]);
        queryClient.invalidateQueries({ queryKey: getGetNodeChatQueryKey(projectId, nodeId) });
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        // silently fail
      }
    } finally {
      setStreamingContent("");
      setIsStreaming(false);
      setOpeningInProgress(false);
    }
  }, [projectId, nodeId, base, openingInProgress, queryClient]);

  useEffect(() => {
    if (chatHistory && !localMessagesLoaded) {
      const msgs = chatHistory.messages as ChatMessage[];
      setLocalMessages(msgs);
      setLocalMessagesLoaded(true);
      if (msgs.length === 0 && node.status !== "locked") {
        generateOpeningMessage();
      }
    }
  }, [chatHistory, localMessagesLoaded]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [localMessages, streamingContent]);

  useEffect(() => {
    return () => {
      openingAbortRef.current?.abort();
      abortRef.current?.abort();
    };
  }, []);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || isStreaming) return;

    setInput("");
    const userMsg: ChatMessage = { role: "user", content, createdAt: new Date().toISOString() };
    setLocalMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);
    setStreamingContent("");

    abortRef.current = new AbortController();

    try {
      const res = await fetch(
        `${base}/api/projects/${projectId}/nodes/${nodeId}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
          signal: abortRef.current.signal,
        }
      );

      if (!res.ok || !res.body) throw new Error("Stream error");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "chunk" && parsed.content) {
                fullContent += parsed.content;
                setStreamingContent(fullContent);
              } else if (parsed.type === "done") {
                // message complete
              } else if (parsed.type === "extra_node_spawned") {
                queryClient.invalidateQueries({ queryKey: getGetNodeMapQueryKey(projectId) });
                queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
                onMapUpdate();
              } else if (parsed.type === "error") {
                throw new Error(parsed.error);
              } else if (parsed.content) {
                fullContent += parsed.content;
                setStreamingContent(fullContent);
              }
            } catch {}
          }
        }
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: fullContent,
        createdAt: new Date().toISOString(),
      };
      setLocalMessages((prev) => [...prev, assistantMsg]);
      setStreamingContent("");
      queryClient.invalidateQueries({ queryKey: getGetNodeChatQueryKey(projectId, nodeId) });
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setLocalMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content: "Sorry, something went wrong. Please try again.",
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } finally {
      setIsStreaming(false);
      setStreamingContent("");
    }
  };

  const handleSpawn = async () => {
    const topic = spawnTopic.trim();
    if (!topic || isSpawning) return;

    setIsSpawning(true);
    try {
      const res = await fetch(
        `${base}/api/projects/${projectId}/nodes/${nodeId}/spawn`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic }),
        }
      );
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: getGetNodeMapQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
        onMapUpdate();
        setSpawnTopic("");
        setShowSpawnInput(false);
      }
    } catch {}
    finally {
      setIsSpawning(false);
    }
  };

  const handleMarkComplete = () => {
    if (!node || node.status === "completed" || node.status === "locked") return;
    updateStatus.mutate({ projectId, nodeId, data: { status: "completed" } });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isCompleted = node.status === "completed";
  const isLocked = node.status === "locked";

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-background">
      <div className="px-4 pt-3 pb-2.5 border-b border-border shrink-0">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-mono font-bold leading-tight truncate" data-testid="node-title">
                {node.title}
              </h2>
              <Badge
                variant={isCompleted ? "default" : isLocked ? "secondary" : "outline"}
                className="text-[10px] uppercase tracking-wider shrink-0"
              >
                {node.status}
              </Badge>
              {node.isExtra && (
                <Badge variant="secondary" className="text-[10px] uppercase tracking-wider shrink-0">
                  Extra
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{node.brief}</p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {!isCompleted && !isLocked && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowSpawnInput((v) => !v)}
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                title="Add extra learning node"
              >
                <Plus className="w-3.5 h-3.5" />
              </Button>
            )}
            {!isCompleted && !isLocked && (
              <Button
                size="sm"
                onClick={handleMarkComplete}
                disabled={updateStatus.isPending}
                data-testid="button-mark-complete"
                className="h-7 text-xs px-2 font-mono"
              >
                {updateStatus.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <>
                    <CheckCircle className="w-3 h-3 mr-1" />
                    Done
                  </>
                )}
              </Button>
            )}
            {isCompleted && (
              <div className="flex items-center gap-1 text-primary text-xs font-mono">
                <CheckCircle className="w-3.5 h-3.5" />
                Done
              </div>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={onClose}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              data-testid="button-close-panel"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {showSpawnInput && (
          <div className="mt-2 flex gap-1.5">
            <input
              type="text"
              value={spawnTopic}
              onChange={(e) => setSpawnTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSpawn()}
              placeholder="Topic to explore deeper..."
              className="flex-1 bg-input border border-border rounded-lg px-2.5 py-1.5 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="spawn-topic-input"
            />
            <Button
              size="sm"
              onClick={handleSpawn}
              disabled={isSpawning || !spawnTopic.trim()}
              data-testid="button-spawn-node"
              className="h-8 text-xs px-2 font-mono"
            >
              {isSpawning ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <>
                  <Sparkles className="w-3 h-3 mr-1" />
                  Spawn
                </>
              )}
            </Button>
          </div>
        )}

        {isCompleted && (node.summary || completedSummary) && (
          <div className="mt-2 px-2.5 py-1.5 bg-primary/10 border border-primary/20 rounded-lg">
            <p className="text-xs text-primary/80 italic leading-relaxed">
              {completedSummary ?? node.summary}
            </p>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {chatLoading && !localMessagesLoaded ? (
          <div className="space-y-3 px-1">
            <Skeleton className="h-14 w-3/4" />
            <Skeleton className="h-10 w-2/3 ml-auto" />
          </div>
        ) : isLocked ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8 px-4">
            <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center mb-3">
              <Lock className="w-5 h-5 text-muted-foreground" />
            </div>
            <p className="font-mono font-semibold text-sm mb-1">Node locked</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              Complete prerequisite nodes first to unlock this topic.
            </p>
          </div>
        ) : localMessages.length === 0 && !streamingContent ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8 px-4">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
              <Sparkles className="w-5 h-5 text-primary" />
            </div>
            <p className="font-mono font-semibold text-sm mb-1">Preparing tutor...</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              Your AI tutor is generating an introduction for <strong>{node.title}</strong>.
            </p>
          </div>
        ) : (
          <>
            {localMessages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}
            {isStreaming && streamingContent && (
              <MessageBubble
                message={{
                  role: "assistant",
                  content: streamingContent,
                  createdAt: new Date().toISOString(),
                }}
              />
            )}
            {isStreaming && !streamingContent && <TypingIndicator />}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="px-3 pb-3 pt-2 border-t border-border shrink-0">
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isLocked ? "Node is locked" : "Ask the tutor anything... (Enter to send)"}
            disabled={isLocked || isStreaming}
            rows={1}
            className="resize-none overflow-hidden font-mono text-xs min-h-[38px] max-h-28 flex-1"
            data-testid="chat-input"
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={!input.trim() || isStreaming || isLocked}
            data-testid="button-send-message"
            className="h-[38px] w-[38px] p-0 shrink-0"
          >
            {isStreaming ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
