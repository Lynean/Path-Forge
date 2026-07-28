import { useEffect, useState } from "react";
import { Link } from "wouter";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";

type LlmMode = "byo" | "free" | "none";

/**
 * Without an API key every AI feature fails, and each widget could only show its
 * own vague "couldn't load" error. This states the real cause once, up front,
 * and points at the one action that fixes it.
 */
export function AiAccessBanner() {
  const [mode, setMode] = useState<LlmMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/llm")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setMode((d?.mode as LlmMode) ?? null);
      })
      .catch(() => {
        if (!cancelled) setMode(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (mode !== "none") return null;

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-400/50 bg-amber-300/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div>
          <p className="text-sm font-semibold">Add an API key to turn on the AI</p>
          <p className="text-xs text-muted-foreground">
            PathForge uses OpenRouter to plan your project and tutor you. Until you add a key it
            can't suggest ideas, build a node map, or answer questions — everything else still works.
          </p>
        </div>
      </div>
      <Button asChild size="sm" className="shrink-0">
        <Link href="/profile">Add your key</Link>
      </Button>
    </div>
  );
}
