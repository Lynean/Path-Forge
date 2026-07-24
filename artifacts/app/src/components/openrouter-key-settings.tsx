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

export function OpenRouterKeySettings() {
  const { toast } = useToast();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const persistsEncrypted = Boolean(getDesktopBridge()?.setOpenRouterKey);

  useEffect(() => {
    fetchStatus().then(setConfigured).catch(() => setConfigured(false));
  }, []);

  const onSave = async () => {
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    try {
      setConfigured(await saveKey(key));
      setValue("");
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
