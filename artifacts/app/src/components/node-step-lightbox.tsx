import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
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
  ChevronLeft,
  ChevronRight,
  Eye,
  ArrowRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Node as ApiNode } from "@workspace/api-client-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Slide {
  type: "intro" | "step";
  stepNumber?: number;
  title?: string;
  content: string; // brief/summary from the opening message
  detailedContent?: string | null; // null = not loaded, string = loaded/streaming
  detailLoading?: boolean;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface NodeStepLightboxProps {
  projectId: number;
  node: ApiNode;
  onClose: () => void;
  onMapUpdate: () => void;
  onExtraNodeCreated?: (nodeId: number) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function MarkdownContent({ content }: { content: string }) {
  // Actions are now delivered as structured tool calls, not text markers, so nothing
  // should appear in content going forward — this strip is legacy-data defense only for
  // messages persisted before that change (mark-done markers used to be saved raw).
  const clean = content.replace(/\[STEP_DONE:\d+\]/g, "").trim();
  return (
    <div className="prose prose-sm prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ code: CodeBlock as any }}
      >
        {clean}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Parse the opening message (which uses [SLIDE:intro] / [SLIDE:N] markers) into
 * an array of Slide objects. Falls back to numbered-list parsing for older messages.
 */
function parseSlides(content: string): Slide[] {
  // ── Try new marker format ─────────────────────────────────────────────────
  if (content.includes("[SLIDE:")) {
    const slides: Slide[] = [];
    const parts = content.split(/\[SLIDE:(\w+)\]/);
    // parts = ["preamble", "intro", "intro content", "1", "step1 content", ...]
    for (let i = 1; i < parts.length - 1; i += 2) {
      const key = parts[i].trim();
      const body = parts[i + 1].trim();
      if (!body) continue;
      if (key === "intro") {
        slides.push({ type: "intro", content: body });
      } else {
        const stepNum = parseInt(key, 10);
        if (!isNaN(stepNum)) {
          const titleMatch = body.match(/^\*\*([^*]+)\*\*/);
          const title = titleMatch ? titleMatch[1].trim() : `Step ${stepNum}`;
          const bodyText = body.replace(/^\*\*[^*]+\*\*\s*\n?/, "").trim();
          slides.push({ type: "step", stepNumber: stepNum, title, content: bodyText });
        }
      }
    }
    if (slides.length > 0) return slides;
  }

  // ── Fall back to old numbered-list format ─────────────────────────────────
  const lines = content.split("\n");
  const introLines: string[] = [];
  const steps: { title: string; lines: string[] }[] = [];
  let inSteps = false;
  let currentStep: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const m =
      line.match(/^\d+\.\s+\*\*([^*]+)\*\*\s*[-–—:]\s*([\s\S]*)/) ||
      line.match(/^\d+\.\s+([^-–—]{2,60})\s*[-–—]\s*([\s\S]*)/);
    if (m) {
      if (!inSteps) {
        inSteps = true;
      }
      if (currentStep) steps.push(currentStep);
      currentStep = { title: m[1].trim(), lines: [m[2]] };
    } else if (currentStep) {
      currentStep.lines.push(line);
    } else {
      introLines.push(line);
    }
  }
  if (currentStep) steps.push(currentStep);

  const result: Slide[] = [];
  if (introLines.some((l) => l.trim())) {
    result.push({ type: "intro", content: introLines.join("\n").trim() });
  }
  steps.forEach((s, i) => {
    result.push({
      type: "step",
      stepNumber: i + 1,
      title: s.title,
      content: s.lines.join("\n").trim(),
    });
  });

  // If parsing failed entirely, show as single intro slide
  if (result.length === 0 && content.trim()) {
    result.push({ type: "intro", content: content.trim() });
  }
  return result;
}

// Actions are delivered as structured tool calls now, not embedded in the reply text, so
// the raw stream content is already the clean display text.
function extractChatDisplay(raw: string): string {
  return raw.trim();
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SlideDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            "rounded-full transition-all duration-200",
            i === current
              ? "w-4 h-1.5 bg-primary"
              : "w-1.5 h-1.5 bg-border"
          )}
        />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  // Legacy-data defense only — new messages never contain these (see MarkdownContent).
  const displayContent = message.content.replace(/\[STEP_DONE:\d+\]/g, "").trim();

  if (!displayContent) return null;

  return (
    <div className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-1">
          <Sparkles className="w-2.5 h-2.5 text-primary" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-secondary text-secondary-foreground rounded-bl-sm"
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{displayContent}</p>
        ) : (
          <MarkdownContent content={displayContent} />
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-2 justify-start">
      <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-1">
        <Sparkles className="w-2.5 h-2.5 text-primary" />
      </div>
      <div className="bg-secondary rounded-2xl rounded-bl-sm px-3 py-2.5">
        <div className="flex gap-1 items-center h-3.5">
          <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function NodeStepLightbox({
  projectId,
  node,
  onClose,
  onMapUpdate,
  onExtraNodeCreated,
}: NodeStepLightboxProps) {
  const nodeId = node.id;
  const queryClient = useQueryClient();
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  // ── Slide state ─────────────────────────────────────────────────────────────
  const [slides, setSlides] = useState<Slide[]>([]);
  const [currentSlideIdx, setCurrentSlideIdx] = useState(0);
  const [isLoadingSlides, setIsLoadingSlides] = useState(false);
  const [streamingRaw, setStreamingRaw] = useState(""); // raw partial stream
  const slidesLoadedRef = useRef(false);

  // ── Chat state ───────────────────────────────────────────────────────────────
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const [chatStreamingContent, setChatStreamingContent] = useState("");
  const [chatLoaded, setChatLoaded] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const openingAbortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const spawnAbortRef = useRef<AbortController | null>(null);
  const visualizeAbortRef = useRef<AbortController | null>(null);

  // ── Spawn / extra node state ─────────────────────────────────────────────────
  const [showSpawnInput, setShowSpawnInput] = useState(false);
  const [spawnTopic, setSpawnTopic] = useState("");
  const [isSpawning, setIsSpawning] = useState(false);
  const [pendingSpawn, setPendingSpawn] = useState<{ nodeId: number; title: string } | null>(null);
  const spawnedExtraNodeRef = useRef<{ nodeId: number; title: string } | null>(null);

  // ── Visualize state ──────────────────────────────────────────────────────────
  const [showVisualizeInput, setShowVisualizeInput] = useState(false);
  const [visualizeTopic, setVisualizeTopic] = useState("");
  const [isVisualizing, setIsVisualizing] = useState(false);
  const [visualizationHtml, setVisualizationHtml] = useState<string | null>(null);
  const [showVisualizationDialog, setShowVisualizationDialog] = useState(false);

  // ── Completion state ─────────────────────────────────────────────────────────
  const [completedSummary, setCompletedSummary] = useState<string | null>(null);

  // ── API hooks ────────────────────────────────────────────────────────────────
  const { data: chatHistory, isLoading: chatHistoryLoading } = useGetNodeChat(projectId, nodeId, {
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
        if (updatedNode?.summary) setCompletedSummary(updatedNode.summary);
      },
    },
  });

  // ── Derived ──────────────────────────────────────────────────────────────────
  const isCompleted = node.status === "completed";
  const isLocked = node.status === "locked";
  const currentSlide = slides[currentSlideIdx] ?? null;
  const isLastSlide = currentSlideIdx >= slides.length - 1 && slides.length > 0;
  const streamingSlides = useMemo(
    () => (streamingRaw ? parseSlides(streamingRaw) : []),
    [streamingRaw]
  );

  // ── Stream opening message ────────────────────────────────────────────────────
  const fetchOpeningMessage = useCallback(async () => {
    setIsLoadingSlides(true);
    setStreamingRaw("");
    openingAbortRef.current = new AbortController();

    try {
      const res = await fetch(
        `${base}/api/projects/${projectId}/nodes/${nodeId}/opening-message`,
        { method: "POST", signal: openingAbortRef.current.signal }
      );
      if (!res.ok || !res.body) {
        setIsLoadingSlides(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";
      let streamError: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.slice(6).trim());
              if (parsed.type === "error") {
                streamError = typeof parsed.error === "string" ? parsed.error : "Stream error";
              } else if (parsed.content) {
                fullContent += parsed.content;
                setStreamingRaw(fullContent);
              }
            } catch {}
          }
        }
      }

      if (streamError) {
        // Even if partial content streamed in before the error (e.g. the response was
        // cut off mid-generation), discard it rather than showing/parsing a truncated,
        // malformed plan.
        setSlides([{ type: "intro", content: "Failed to load session. Please close and try again." }]);
      } else if (fullContent) {
        const parsed = parseSlides(fullContent);
        setSlides(parsed);
        setCurrentSlideIdx(0);
        // Save to DB (the endpoint already handles this)
        queryClient.invalidateQueries({ queryKey: getGetNodeChatQueryKey(projectId, nodeId) });
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setSlides([{ type: "intro", content: "Failed to load session. Please close and try again." }]);
      }
    } finally {
      setStreamingRaw("");
      setIsLoadingSlides(false);
    }
  }, [projectId, nodeId, base, queryClient]);

  // ── Reset when node changes (must run BEFORE the load effect) ───────────────
  useEffect(() => {
    slidesLoadedRef.current = false;
    setSlides([]);
    setCurrentSlideIdx(0);
    setChatMessages([]);
    setChatLoaded(false);
    setStreamingRaw("");
  }, [nodeId]);

  // ── Load history or stream (runs after reset on mount) ────────────────────
  useEffect(() => {
    if (chatHistoryLoading || slidesLoadedRef.current) return;
    const allMsgs = (chatHistory?.messages ?? []) as ChatMessage[];

    // Separate step-detail messages (encoded as assistant messages with marker)
    // from real chat messages shown in the side panel.
    const STEP_DETAIL_RE = /^\[STEP_DETAIL:(\d+)\]\n([\s\S]*)\n\[\/STEP_DETAIL:\d+\]$/;
    const savedDetails = new Map<number, string>();
    const chatMsgs: ChatMessage[] = [];
    for (const m of allMsgs) {
      const match = m.role === "assistant" ? STEP_DETAIL_RE.exec(m.content) : null;
      if (match) {
        savedDetails.set(parseInt(match[1], 10), match[2]);
      } else {
        chatMsgs.push(m);
      }
    }

    setChatMessages(chatMsgs);
    setChatLoaded(true);

    if (chatMsgs.length > 0) {
      const opening = chatMsgs.find((m) => m.role === "assistant");
      if (opening) {
        const parsed = parseSlides(opening.content);
        // Hydrate any previously generated step details
        const hydrated = parsed.map((s) => {
          if (s.type === "step" && s.stepNumber !== undefined && savedDetails.has(s.stepNumber)) {
            return { ...s, detailedContent: savedDetails.get(s.stepNumber)!, detailLoading: false };
          }
          return s;
        });
        setSlides(hydrated);
        setCurrentSlideIdx(0);
        slidesLoadedRef.current = true;
        return;
      }
    }

    if (node.status !== "locked") {
      slidesLoadedRef.current = true;
      fetchOpeningMessage();
    }
  }, [chatHistory, chatHistoryLoading]);

  // ── Stream detailed content for a step on first visit ─────────────────────
  const stepDetailAbortRef = useRef<AbortController | null>(null);

  const streamStepDetailContent = useCallback(async (slideIdx: number) => {
    const slide = slides[slideIdx];
    if (!slide || slide.type !== "step" || slide.detailedContent !== undefined) return;

    // Mark as loading
    setSlides((prev) =>
      prev.map((s, i) => (i === slideIdx ? { ...s, detailedContent: null, detailLoading: true } : s))
    );

    stepDetailAbortRef.current?.abort();
    stepDetailAbortRef.current = new AbortController();

    try {
      const res = await fetch(`${base}/api/projects/${projectId}/nodes/${nodeId}/step-detail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stepIndex: slide.stepNumber ?? slideIdx,
          stepTitle: slide.title ?? "",
          stepBrief: slide.content,
        }),
        signal: stepDetailAbortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        setSlides((prev) =>
          prev.map((s, i) =>
            i === slideIdx ? { ...s, detailedContent: "Failed to load step detail.", detailLoading: false } : s
          )
        );
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
            try {
              const parsed = JSON.parse(line.slice(6).trim());
              if (parsed.type === "chunk" && parsed.content) {
                fullContent += parsed.content;
                // Update progressively while streaming
                setSlides((prev) =>
                  prev.map((s, i) =>
                    i === slideIdx ? { ...s, detailedContent: fullContent, detailLoading: true } : s
                  )
                );
              } else if (parsed.type === "done") {
                setSlides((prev) =>
                  prev.map((s, i) =>
                    i === slideIdx ? { ...s, detailedContent: fullContent, detailLoading: false } : s
                  )
                );
                // Refresh cache so the persisted detail is available on next open
                queryClient.invalidateQueries({ queryKey: getGetNodeChatQueryKey(projectId, nodeId) });
              } else if (parsed.type === "error") {
                // Discard any partial content that streamed in before the error (e.g.
                // the response was cut off mid-generation) rather than showing a
                // truncated walkthrough as if it were complete.
                setSlides((prev) =>
                  prev.map((s, i) =>
                    i === slideIdx
                      ? { ...s, detailedContent: "Failed to load step detail.", detailLoading: false }
                      : s
                  )
                );
              }
            } catch {}
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setSlides((prev) =>
          prev.map((s, i) =>
            i === slideIdx ? { ...s, detailedContent: "Failed to load step detail.", detailLoading: false } : s
          )
        );
      }
    }
  }, [slides, base, projectId, nodeId]);

  // Auto-trigger step detail when navigating to a step slide
  useEffect(() => {
    const slide = slides[currentSlideIdx];
    if (slide?.type === "step" && slide.detailedContent === undefined && !isLoadingSlides) {
      streamStepDetailContent(currentSlideIdx);
    }
  }, [currentSlideIdx, slides, isLoadingSlides]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatStreamingContent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      openingAbortRef.current?.abort();
      chatAbortRef.current?.abort();
      stepDetailAbortRef.current?.abort();
      spawnAbortRef.current?.abort();
      visualizeAbortRef.current?.abort();
    };
  }, []);

  // ── Chat send ─────────────────────────────────────────────────────────────────
  const sendChatMessage = async (content: string) => {
    if (!content.trim() || isChatStreaming) return;

    const contextPrefix = currentSlide && currentSlide.type === "step"
      ? `[Context: I'm on step ${currentSlide.stepNumber} — "${currentSlide.title}"]\n`
      : "";
    const fullContent = contextPrefix + content.trim();

    const userMsg: ChatMessage = {
      role: "user",
      content: content.trim(), // display without prefix
      createdAt: new Date().toISOString(),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setIsChatStreaming(true);
    setChatStreamingContent("");

    chatAbortRef.current = new AbortController();

    try {
      const res = await fetch(`${base}/api/projects/${projectId}/nodes/${nodeId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: fullContent, completedStepIndices: [] }),
        signal: chatAbortRef.current.signal,
      });

      if (!res.ok || !res.body) throw new Error("Stream error");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = "";
      let buffer = "";
      let streamError: string | null = null;
      let planUpdateFailed = false;
      let resolvedContent: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.slice(6).trim());
              if (parsed.type === "error") {
                streamError = typeof parsed.error === "string" ? parsed.error : "Stream error";
              } else if (parsed.type === "chunk" && parsed.content) {
                fullResponse += parsed.content;
                setChatStreamingContent(extractChatDisplay(fullResponse));
              } else if (parsed.type === "plan_updated" && typeof parsed.openingContent === "string") {
                // Server has already applied the update_step/regenerate_session/add_steps
                // tool call(s) to the canonical session plan and purged the step-detail
                // pages that are now stale. Re-parse it and, for each step, carry over
                // cached detail only if that step's own content is byte-identical to
                // before — this alone correctly covers every action type: an update_step
                // call that only touches the intro (via its optional introUpdate field)
                // leaves every step body unchanged (all steps keep their cache), one that
                // also rewrites a step invalidates just that one, and regenerate_session's
                // freshly written steps will differ from the old ones and regenerate
                // naturally. The intro slide itself always reflects the fresh text
                // immediately since it isn't cached — no special-casing needed for that.
                const newSlides = parseSlides(parsed.openingContent);
                setSlides((prev) =>
                  newSlides.map((s) => {
                    if (s.type !== "step") return s;
                    const old = prev.find(
                      (p) => p.type === "step" && p.stepNumber === s.stepNumber && p.content === s.content
                    );
                    return old && old.detailedContent !== undefined
                      ? { ...s, detailedContent: old.detailedContent, detailLoading: old.detailLoading }
                      : s;
                  })
                );
              } else if (parsed.type === "plan_update_failed") {
                planUpdateFailed = true;
              } else if (parsed.type === "done") {
                // The resolved display text — may differ from what streamed as "chunk"
                // events. In particular, the model can call tools with no reply text at
                // all; the server synthesizes a short notification in that case ("Updated
                // step 3.") which never streams as a chunk, so it must be read from here.
                if (typeof parsed.content === "string") resolvedContent = parsed.content;
              } else if (parsed.type === "extra_node_spawned") {
                spawnedExtraNodeRef.current = {
                  nodeId: parsed.nodeId as number,
                  title: parsed.title as string,
                };
                queryClient.invalidateQueries({ queryKey: getGetNodeMapQueryKey(projectId) });
                queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
                onMapUpdate();
              } else if (parsed.content) {
                fullResponse += parsed.content;
                setChatStreamingContent(extractChatDisplay(fullResponse));
              }
            } catch {}
          }
        }
      }

      if (streamError) {
        // Discard any partial content that streamed in before the error (e.g. the
        // response was cut off mid-generation) rather than showing/saving a fragment.
        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content: "Sorry, something went wrong. Please try again.",
            createdAt: new Date().toISOString(),
          },
        ]);
        return;
      }

      // Check for spawned extra node
      const spawnInfo = spawnedExtraNodeRef.current;
      spawnedExtraNodeRef.current = null;
      if (spawnInfo) {
        setPendingSpawn(spawnInfo);
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: resolvedContent !== null ? resolvedContent : extractChatDisplay(fullResponse),
        createdAt: new Date().toISOString(),
      };
      setChatMessages((prev) =>
        planUpdateFailed
          ? [
              ...prev,
              assistantMsg,
              {
                role: "assistant" as const,
                content: "_Couldn't rebuild the session plan — please ask again._",
                createdAt: new Date().toISOString(),
              },
            ]
          : [...prev, assistantMsg]
      );
      queryClient.invalidateQueries({ queryKey: getGetNodeChatQueryKey(projectId, nodeId) });
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant" as const,
            content: "Sorry, something went wrong. Please try again.",
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    } finally {
      setIsChatStreaming(false);
      setChatStreamingContent("");
    }
  };

  const handleChatSend = () => {
    const val = chatInput.trim();
    if (!val) return;
    setChatInput("");
    sendChatMessage(val);
  };

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleChatSend();
    }
  };

  // ── Spawn node ─────────────────────────────────────────────────────────────
  const handleSpawn = async () => {
    const topic = spawnTopic.trim();
    if (!topic || isSpawning) return;
    setIsSpawning(true);
    spawnAbortRef.current = new AbortController();
    try {
      const res = await fetch(`${base}/api/projects/${projectId}/nodes/${nodeId}/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
        signal: spawnAbortRef.current.signal,
      });
      if (res.ok) {
        const data = await res.json();
        queryClient.invalidateQueries({ queryKey: getGetNodeMapQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectStatsQueryKey(projectId) });
        onMapUpdate();
        setSpawnTopic("");
        setShowSpawnInput(false);
        // Find the newly created extra node: connected from current node, isExtra=true
        const edges: Array<{ fromNodeId: number; toNodeId: number }> = data.edges ?? [];
        const childIds = new Set(edges.filter((e) => e.fromNodeId === nodeId).map((e) => e.toNodeId));
        const extraChildren = (data.nodes ?? []).filter(
          (n: { id: number; isExtra?: boolean }) => childIds.has(n.id) && n.isExtra
        );
        const newNode = extraChildren[extraChildren.length - 1];
        if (newNode) {
          setPendingSpawn({ nodeId: newNode.id, title: newNode.title ?? topic });
        }
      }
    } catch {}
    finally {
      setIsSpawning(false);
    }
  };

  // ── Visualize ──────────────────────────────────────────────────────────────
  const handleVisualize = async () => {
    const topic = visualizeTopic.trim();
    if (!topic || isVisualizing) return;
    setIsVisualizing(true);
    setVisualizationHtml("");
    setShowVisualizationDialog(true);
    setShowVisualizeInput(false);
    let accumulated = "";
    visualizeAbortRef.current = new AbortController();
    try {
      const res = await fetch(`${base}/api/projects/${projectId}/nodes/${nodeId}/visualize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
        signal: visualizeAbortRef.current.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: string | null = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.slice(6).trim());
              if (parsed.type === "error") {
                streamError = typeof parsed.error === "string" ? parsed.error : "Stream error";
              } else if (parsed.type === "chunk" && parsed.content) {
                accumulated += parsed.content;
              }
            } catch {}
          }
        }
      }
      if (streamError) {
        // Discard any partial HTML that streamed in before the error rather than
        // rendering a truncated/broken document.
        throw new Error(streamError);
      }
      const clean = accumulated
        .replace(/^```(?:html)?\s*\n?/i, "")
        .replace(/\n?```\s*$/, "")
        .trim();
      setVisualizationHtml(clean);
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setVisualizationHtml(
          `<html><body style="font-family:monospace;color:#e74c3c;padding:16px">Error: ${err?.message ?? "Unknown"}</body></html>`
        );
      }
    } finally {
      setIsVisualizing(false);
    }
  };

  // ── Mark complete ──────────────────────────────────────────────────────────
  const handleMarkComplete = () => {
    if (isCompleted || isLocked) return;
    updateStatus.mutate({ projectId, nodeId, data: { status: "completed" } });
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const displaySlides = isLoadingSlides && streamingSlides.length > 0 ? streamingSlides : slides;
  const showStreamingState = isLoadingSlides && displaySlides.length === 0;

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent
          className="max-w-[92vw] w-full p-0 gap-0 overflow-hidden flex flex-col [&>button:last-child]:hidden"
          style={{ height: "88vh" }}
        >
          {/* ── Header ── */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-sm font-mono font-bold truncate">{node.title}</h2>
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
                {node.brief && (
                  <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{node.brief}</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {!isLocked && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setShowVisualizeInput((v) => !v); setShowSpawnInput(false); }}
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                  title="Visualize a concept"
                >
                  <Eye className="w-3.5 h-3.5" />
                </Button>
              )}
              {!isCompleted && !isLocked && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setShowSpawnInput((v) => !v); setShowVisualizeInput(false); }}
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                  title="Create a new learning node"
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              )}
              {isCompleted ? (
                <div className="flex items-center gap-1 text-primary text-xs font-mono">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Done
                </div>
              ) : !isLocked && isLastSlide ? (
                <Button
                  size="sm"
                  onClick={handleMarkComplete}
                  disabled={updateStatus.isPending}
                  className="h-7 text-xs px-2.5 font-mono"
                >
                  {updateStatus.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <>
                      <CheckCircle className="w-3 h-3 mr-1" />
                      Mark Done
                    </>
                  )}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={onClose}
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          {/* Quick-action bars */}
          {(showSpawnInput || showVisualizeInput) && (
            <div className="px-5 py-2 border-b border-border bg-muted/20 shrink-0">
              {showSpawnInput && (
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={spawnTopic}
                    onChange={(e) => setSpawnTopic(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSpawn()}
                    placeholder="Topic to explore deeper..."
                    autoFocus
                    className="flex-1 bg-input border border-border rounded-lg px-2.5 py-1.5 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <Button
                    size="sm"
                    onClick={handleSpawn}
                    disabled={isSpawning || !spawnTopic.trim()}
                    className="h-8 text-xs px-2 font-mono"
                  >
                    {isSpawning ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Sparkles className="w-3 h-3 mr-1" />Add Node</>}
                  </Button>
                </div>
              )}
              {showVisualizeInput && (
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={visualizeTopic}
                    onChange={(e) => setVisualizeTopic(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleVisualize()}
                    placeholder="What do you want to visualize?"
                    autoFocus
                    className="flex-1 bg-input border border-border rounded-lg px-2.5 py-1.5 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <Button
                    size="sm"
                    onClick={handleVisualize}
                    disabled={isVisualizing || !visualizeTopic.trim()}
                    className="h-8 text-xs px-2 font-mono"
                  >
                    {isVisualizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Eye className="w-3 h-3 mr-1" />Go</>}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Completed summary banner */}
          {isCompleted && (node.summary || completedSummary) && (
            <div className="px-5 py-2 bg-primary/10 border-b border-primary/20 shrink-0">
              <p className="text-xs text-primary/80 italic">{completedSummary ?? node.summary}</p>
            </div>
          )}

          {/* ── Body ── */}
          <div className="flex flex-1 min-h-0 overflow-hidden">

            {/* ── LEFT: Step Slider ── */}
            <div className="flex flex-col flex-[58] border-r border-border min-h-0 overflow-hidden">
              {/* Slide content area */}
              <div className="flex-1 min-h-0 overflow-y-auto px-8 py-6">
                {isLocked ? (
                  <div className="flex flex-col items-center justify-center h-full text-center py-12">
                    <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center mb-4">
                      <Lock className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <p className="font-mono font-semibold mb-1">Node locked</p>
                    <p className="text-sm text-muted-foreground max-w-xs">
                      Complete prerequisite nodes first to unlock this topic.
                    </p>
                  </div>
                ) : showStreamingState ? (
                  <div className="flex flex-col items-center justify-center h-full text-center py-12 gap-4">
                    <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    <div>
                      <p className="font-mono font-semibold text-sm">Preparing your session...</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        AI is generating your personalized steps for <strong>{node.title}</strong>
                      </p>
                    </div>
                  </div>
                ) : displaySlides.length === 0 ? (
                  <div className="space-y-4">
                    <Skeleton className="h-6 w-2/3" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-4/5" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                ) : currentSlide ? (
                  <div className="max-w-2xl">
                    {/* ── Intro slide: show overview + all step summaries ── */}
                    {currentSlide.type === "intro" ? (
                      <>
                        <div className="mb-5">
                          <div className="flex items-center gap-2 mb-3">
                            <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center">
                              <Sparkles className="w-3 h-3 text-primary" />
                            </div>
                            <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                              Session Overview
                            </span>
                          </div>
                          <h3 className="text-lg font-mono font-bold mb-4">{node.title}</h3>
                        </div>

                        {/* Intro text (checkpoint / description) */}
                        <div className="text-sm leading-relaxed mb-6">
                          <MarkdownContent content={currentSlide.content} />
                        </div>

                        {/* All step summaries */}
                        {displaySlides.filter((s) => s.type === "step").length > 0 && (
                          <div className="space-y-3">
                            <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">
                              What you'll do in this session
                            </p>
                            {displaySlides
                              .filter((s) => s.type === "step")
                              .map((s, i) => (
                                <div
                                  key={i}
                                  className="flex gap-3 p-3 rounded-lg bg-muted/30 border border-border/50 cursor-pointer hover:bg-muted/50 transition-colors"
                                  onClick={() => setCurrentSlideIdx(displaySlides.findIndex((d) => d === s))}
                                >
                                  <div className="w-5 h-5 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-[10px] font-mono font-bold text-primary shrink-0 mt-0.5">
                                    {s.stepNumber}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="text-sm font-mono font-semibold leading-tight">{s.title}</p>
                                    <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-3 [&_.katex]:text-xs">
                                      <MarkdownContent content={s.content} />
                                    </div>
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}
                      </>
                    ) : (
                      /* ── Step slide: header + streamed detailed content ── */
                      <>
                        <div className="mb-5">
                          <div className="flex items-center gap-2 mb-2">
                            <div className="w-6 h-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-[10px] font-mono font-bold text-primary">
                              {currentSlide.stepNumber}
                            </div>
                            <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                              Step {currentSlide.stepNumber} of {displaySlides.filter(s => s.type === "step").length}
                            </span>
                          </div>
                          <h3 className="text-lg font-mono font-bold mb-1">{currentSlide.title}</h3>
                          <div className="text-xs text-muted-foreground leading-relaxed">
                            <MarkdownContent content={currentSlide.content} />
                          </div>
                        </div>

                        {/* Detailed content */}
                        {currentSlide.detailLoading && !currentSlide.detailedContent ? (
                          <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                            <div className="w-7 h-7 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                            <p className="text-xs font-mono">Generating detailed walkthrough...</p>
                          </div>
                        ) : currentSlide.detailedContent ? (
                          <div className="text-sm leading-relaxed">
                            <MarkdownContent content={currentSlide.detailedContent} />
                            {currentSlide.detailLoading && (
                              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground font-mono mt-2">
                                <Loader2 className="w-3 h-3 animate-spin" /> generating...
                              </span>
                            )}
                          </div>
                        ) : null}
                      </>
                    )}

                    {/* Streaming indicator for last partial opening slide */}
                    {isLoadingSlides && currentSlideIdx === displaySlides.length - 1 && (
                      <div className="flex items-center gap-2 mt-4 text-muted-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span className="text-xs font-mono">Loading more steps...</span>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              {/* ── Slide navigation ── */}
              {!isLocked && displaySlides.length > 0 && (
                <div className="px-8 py-4 border-t border-border shrink-0 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <SlideDots total={displaySlides.length} current={currentSlideIdx} />
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {currentSlideIdx + 1} / {displaySlides.length}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {currentSlideIdx > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCurrentSlideIdx((i) => i - 1)}
                        className="h-8 px-3 text-xs font-mono text-muted-foreground"
                      >
                        <ChevronLeft className="w-3.5 h-3.5 mr-1" />
                        Back
                      </Button>
                    )}
                    {!isLastSlide ? (
                      <Button
                        size="sm"
                        onClick={() => setCurrentSlideIdx((i) => i + 1)}
                        disabled={isLoadingSlides && currentSlideIdx >= displaySlides.length - 1}
                        className="h-8 px-4 text-xs font-mono"
                      >
                        Proceed
                        <ChevronRight className="w-3.5 h-3.5 ml-1" />
                      </Button>
                    ) : (
                      !isCompleted && (
                        <Button
                          size="sm"
                          onClick={handleMarkComplete}
                          disabled={updateStatus.isPending}
                          className="h-8 px-4 text-xs font-mono bg-primary/90 hover:bg-primary"
                        >
                          {updateStatus.isPending ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <>
                              <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                              Mark Complete
                            </>
                          )}
                        </Button>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── RIGHT: Side Chat ── */}
            <div className="flex flex-col flex-[42] min-h-0 overflow-hidden">
              {/* Chat label */}
              <div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center gap-2">
                <Sparkles className="w-3 h-3 text-primary" />
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  AI Tutor
                </span>
                {currentSlide?.type === "step" && (
                  <span className="text-[10px] font-mono text-muted-foreground/50 truncate">
                    · step {currentSlide.stepNumber}
                  </span>
                )}
              </div>

              {/* Messages */}
              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
                {!chatLoaded && chatHistoryLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-12 w-3/4" />
                    <Skeleton className="h-8 w-1/2 ml-auto" />
                  </div>
                ) : chatMessages.length === 0 && !isChatStreaming ? (
                  <div className="flex flex-col items-center justify-center h-full text-center py-6 text-muted-foreground">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                      <Sparkles className="w-4 h-4 text-primary" />
                    </div>
                    <p className="text-xs font-mono">
                      {isLocked
                        ? "Node is locked"
                        : "Ask anything about the current step."}
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Filter out the opening message (first assistant message) from chat display */}
                    {chatMessages.slice(
                      chatMessages.findIndex((m) => m.role === "user") >= 0
                        ? chatMessages.findIndex((m) => m.role === "user")
                        : chatMessages.length
                    ).map((msg, i) => {
                      // Render [EXTRA_REDIRECT:{...}] as a clickable link
                      if (msg.role === "assistant" && msg.content.startsWith("[EXTRA_REDIRECT:")) {
                        try {
                          const data = JSON.parse(msg.content.slice("[EXTRA_REDIRECT:".length, -1)) as { nodeId: number; title: string };
                          return (
                            <div key={i} className="flex justify-start">
                              <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/20 rounded-2xl rounded-bl-sm max-w-[90%]">
                                <ArrowRight className="w-3 h-3 text-primary shrink-0" />
                                <span className="text-xs text-muted-foreground">
                                  Topic moved to{" "}
                                  <button
                                    onClick={() => onExtraNodeCreated?.(data.nodeId)}
                                    className="font-mono font-semibold text-primary hover:underline cursor-pointer"
                                  >
                                    {data.title}
                                  </button>
                                  {" "}for deeper exploration.
                                </span>
                              </div>
                            </div>
                          );
                        } catch {}
                      }
                      return <MessageBubble key={i} message={msg} />;
                    })}
                    {isChatStreaming && chatStreamingContent && (
                      <MessageBubble
                        message={{ role: "assistant", content: chatStreamingContent, createdAt: new Date().toISOString() }}
                      />
                    )}
                    {isChatStreaming && !chatStreamingContent && <TypingIndicator />}
                  </>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Chat input */}
              <div className="px-4 pb-4 pt-2 border-t border-border shrink-0">
                <div className="flex gap-2 items-end">
                  <Textarea
                    ref={textareaRef}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={handleChatKeyDown}
                    placeholder={
                      isLocked
                        ? "Node is locked"
                        : currentSlide?.type === "step"
                        ? `Ask about step ${currentSlide.stepNumber}...`
                        : "Ask the AI tutor anything..."
                    }
                    disabled={isLocked || isChatStreaming}
                    rows={1}
                    className="resize-none overflow-hidden font-mono text-xs min-h-[38px] max-h-28 flex-1"
                  />
                  <Button
                    size="sm"
                    onClick={handleChatSend}
                    disabled={!chatInput.trim() || isChatStreaming || isLocked}
                    className="h-[38px] w-[38px] p-0 shrink-0"
                  >
                    {isChatStreaming ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground/40 font-mono mt-1.5 text-right">
                  The AI tutor answers your questions here.
                </p>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Spawn confirmation dialog */}
      <AlertDialog open={!!pendingSpawn} onOpenChange={(open) => { if (!open) setPendingSpawn(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono">New node created</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-semibold text-foreground">"{pendingSpawn?.title}"</span> has been added to your learning map.
              Do you want to switch to it now?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingSpawn(null)}>
              Stay here
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const nodeId = pendingSpawn?.nodeId;
                setPendingSpawn(null);
                if (nodeId) {
                  // onExtraNodeCreated sets selectedNodeId + URL → lightbox remounts for new node
                  onExtraNodeCreated?.(nodeId);
                }
              }}
            >
              <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
              Switch to new node
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Visualization dialog */}
      <Dialog open={showVisualizationDialog} onOpenChange={setShowVisualizationDialog}>
        <DialogContent className="max-w-3xl w-full p-0 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Eye className="w-4 h-4 text-primary" />
            <span className="font-mono text-sm font-semibold">{visualizeTopic || "Visualization"}</span>
          </div>
          <div className="relative w-full" style={{ height: "520px" }}>
            {isVisualizing ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground font-mono">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
                <span className="text-xs">Generating visualization...</span>
              </div>
            ) : visualizationHtml ? (
              <iframe
                srcDoc={visualizationHtml}
                sandbox="allow-scripts"
                className="w-full h-full border-0"
                title="Visualization"
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
