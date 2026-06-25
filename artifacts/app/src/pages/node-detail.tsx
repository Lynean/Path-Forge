import { useState, useRef, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import {
  useGetProject,
  useGetNodeMap,
  useUpdateNodeStatus,
  useGetNodeChat,
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
import { ArrowLeft, Send, CheckCircle, Loader2, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-1">
          <Sparkles className="w-3.5 h-3.5 text-primary" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-secondary text-secondary-foreground rounded-bl-sm"
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-3 justify-start">
      <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-1">
        <Sparkles className="w-3.5 h-3.5 text-primary" />
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

export default function NodeDetail() {
  const [matchNode, paramsNode] = useRoute("/projects/:projectId/nodes/:nodeId");
  const projectId = matchNode ? parseInt(paramsNode.projectId, 10) : 0;
  const nodeId = matchNode ? parseInt(paramsNode.nodeId, 10) : 0;

  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const [input, setInput] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [localMessagesLoaded, setLocalMessagesLoaded] = useState(false);
  const [spawnTopic, setSpawnTopic] = useState("");
  const [showSpawnInput, setShowSpawnInput] = useState(false);
  const [isSpawning, setIsSpawning] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { data: project } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId) },
  });
  const { data: map } = useGetNodeMap(projectId, {
    query: { enabled: !!projectId, queryKey: getGetNodeMapQueryKey(projectId) },
  });
  const { data: chatHistory, isLoading: chatLoading } = useGetNodeChat(projectId, nodeId, {
    query: {
      enabled: !!projectId && !!nodeId,
      queryKey: getGetNodeChatQueryKey(projectId, nodeId),
    },
  });

  const updateStatus = useUpdateNodeStatus({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetNodeMapQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      },
    },
  });

  const node = map?.nodes.find((n) => n.id === nodeId);

  useEffect(() => {
    if (chatHistory && !localMessagesLoaded) {
      setLocalMessages(chatHistory.messages as ChatMessage[]);
      setLocalMessagesLoaded(true);
    }
  }, [chatHistory, localMessagesLoaded]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [localMessages, streamingContent]);

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
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
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

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
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
      const base = import.meta.env.BASE_URL.replace(/\/$/, "");
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
        setSpawnTopic("");
        setShowSpawnInput(false);
      }
    } catch {}
    finally {
      setIsSpawning(false);
    }
  };

  const handleMarkComplete = () => {
    if (!node || node.status === "completed") return;
    updateStatus.mutate({ projectId, nodeId, data: { status: "completed" } });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!matchNode) return null;

  if (!node) {
    return (
      <div className="flex items-center justify-center h-full p-10">
        <div className="space-y-4 text-center">
          <p className="text-muted-foreground">
            {map ? "Node not found." : "Loading..."}
          </p>
          <Button variant="outline" onClick={() => setLocation(`/projects/${projectId}`)}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to map
          </Button>
        </div>
      </div>
    );
  }

  const isCompleted = node.status === "completed";
  const isLocked = node.status === "locked";
  const allMessages = localMessages;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 md:px-6 pt-4 pb-3 border-b border-border shrink-0">
        <div className="flex items-start gap-3 max-w-3xl mx-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocation(`/projects/${projectId}`)}
            className="shrink-0 -ml-1 mt-0.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-mono font-bold leading-tight" data-testid="node-title">
                {node.title}
              </h1>
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
            <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{node.brief}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSpawnInput((v) => !v)}
              className="text-muted-foreground hover:text-foreground"
              title="Spawn extra learning node"
            >
              <Plus className="w-4 h-4" />
            </Button>
            {!isCompleted && !isLocked && (
              <Button
                size="sm"
                onClick={handleMarkComplete}
                disabled={updateStatus.isPending}
                data-testid="button-mark-complete"
                className="font-mono"
              >
                {updateStatus.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <>
                    <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                    Done
                  </>
                )}
              </Button>
            )}
            {isCompleted && (
              <div className="flex items-center gap-1.5 text-primary text-sm font-mono">
                <CheckCircle className="w-4 h-4" />
                Completed
              </div>
            )}
          </div>
        </div>

        {showSpawnInput && (
          <div className="mt-3 max-w-3xl mx-auto">
            <div className="flex gap-2">
              <input
                type="text"
                value={spawnTopic}
                onChange={(e) => setSpawnTopic(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSpawn()}
                placeholder="Topic to explore deeper (e.g. 'async/await patterns')..."
                className="flex-1 bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                data-testid="spawn-topic-input"
              />
              <Button
                size="sm"
                onClick={handleSpawn}
                disabled={isSpawning || !spawnTopic.trim()}
                data-testid="button-spawn-node"
                className="font-mono"
              >
                {isSpawning ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                    Spawn
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-4 max-w-3xl mx-auto w-full">
        {chatLoading && !localMessagesLoaded ? (
          <div className="space-y-4">
            <Skeleton className="h-12 w-2/3" />
            <Skeleton className="h-16 w-3/4 ml-auto" />
          </div>
        ) : allMessages.length === 0 && !streamingContent ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
              <Sparkles className="w-6 h-6 text-primary" />
            </div>
            <p className="font-mono font-semibold mb-1">Start learning</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              Ask the AI tutor anything about <strong>{node.title}</strong>. Get explanations, examples, and code.
            </p>
          </div>
        ) : (
          <>
            {allMessages.map((msg, i) => (
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

      <div className="px-4 md:px-6 pb-4 pt-2 border-t border-border shrink-0">
        <div className="max-w-3xl mx-auto flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isLocked ? "This node is locked" : "Ask the AI tutor anything... (Enter to send)"}
            disabled={isLocked || isStreaming}
            rows={1}
            className="resize-none overflow-hidden font-mono text-sm min-h-[42px] max-h-32 flex-1"
            data-testid="chat-input"
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={!input.trim() || isStreaming || isLocked}
            data-testid="button-send-message"
            className="h-[42px] px-3"
          >
            {isStreaming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
