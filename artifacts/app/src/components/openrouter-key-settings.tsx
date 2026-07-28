import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getDesktopBridge } from "@/lib/desktop";

// Prefer the Electron bridge (main persists the key encrypted via safeStorage and
// pushes it to the local backend). When there is no bridge (e.g. a plain local
// browser session) fall back to the backend's settings API directly — session-only,
// no encrypted persistence. Either way the key stays on this machine.
async function fetchStatus(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (bridge?.getOpenRouterStatus) return (await bridge.getOpenRouterStatus()).configured;
  const res = await fetch("/api/settings/openrouter");
  return res.ok ? Boolean((await res.json())?.configured) : false;
}

async function saveKey(key: string): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (bridge?.setOpenRouterKey) return (await bridge.setOpenRouterKey(key)).configured;
  const res = await fetch("/api/settings/openrouter", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: key }),
  });
  if (!res.ok) throw new Error(`Save failed (${res.status})`);
  return Boolean((await res.json())?.configured);
}

async function removeKey(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (bridge?.clearOpenRouterKey) return (await bridge.clearOpenRouterKey()).configured;
  const res = await fetch("/api/settings/openrouter", { method: "DELETE" });
  return res.ok ? Boolean((await res.json())?.configured) : false;
}

interface LlmStatus {
  mode: "byo" | "free" | "none";
  freeTierAvailable: boolean;
  quota: {
    deviceRequestsRemaining: number;
    deviceTokensRemaining: number;
    deviceCostRemainingUsd?: number;
    resetsAt: string;
  } | null;
}

export function OpenRouterKeySettings() {
  const { toast } = useToast();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const persistsEncrypted = Boolean(getDesktopBridge()?.setOpenRouterKey);

  const refreshLlm = () =>
    fetch("/api/settings/llm")
      .then((r) => (r.ok ? r.json() : null))
      .then(setLlm)
      .catch(() => setLlm(null));

  useEffect(() => {
    fetchStatus().then(setConfigured).catch(() => setConfigured(false));
    void refreshLlm();
  }, []);

  const onSave = async () => {
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    try {
      setConfigured(await saveKey(key));
      setValue("");
      await refreshLlm();
      toast({ title: "API key saved" });
    } catch (err: any) {
      toast({ title: "Could not save key", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    setBusy(true);
    try {
      setConfigured(await removeKey());
      await refreshLlm();
      toast({ title: "API key removed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-10 pt-8 border-t border-border space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-mono font-bold tracking-tight">OpenRouter API Key</h2>
        <span className={`text-xs font-medium ${configured ? "text-green-600" : "text-muted-foreground"}`}>
          {configured === null ? "Checking…" : configured ? "● Configured" : "○ Not set"}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        PathForge calls the AI through your own OpenRouter key. It's stored
        {persistsEncrypted ? " encrypted on this device" : " for this session"} and used only by
        the local app — it never leaves your machine except to reach OpenRouter.{" "}
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-foreground"
        >
          Get a key
        </a>
        .
      </p>
      {llm?.mode === "free" && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-300/15 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-200/90">
          <b>You're on the free trial.</b>{" "}
          {llm.quota
            ? `${llm.quota.deviceRequestsRemaining} requests left today` +
              (typeof llm.quota.deviceCostRemainingUsd === "number"
                ? ` ($${llm.quota.deviceCostRemainingUsd.toFixed(2)} of credit).`
                : ".")
            : "A shared allowance is being used."}{" "}
          Add your own key below for unlimited use — it's free to create and you only pay OpenRouter for what you use.
        </div>
      )}
      {llm?.mode === "none" && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px]">
          <b>No AI access yet.</b> Add your OpenRouter key below to start.
        </div>
      )}
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder="sk-or-v1-…"
          value={value}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave();
          }}
        />
        <Button type="button" onClick={onSave} disabled={busy || !value.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {configured && (
          <Button type="button" variant="outline" onClick={onClear} disabled={busy}>
            Remove
          </Button>
        )}
      </div>
    </section>
  );
}
