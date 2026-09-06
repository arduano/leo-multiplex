import { useEffect, useState, type PropsWithChildren } from "react";
import { configureDraftScope, flushDrafts, lastDraftScope } from "./session-drafts.js";
import { MobileSettings } from "./mobile-settings.js";
import { registerPwa, updatePwa, usePwa } from "./pwa.js";
import { useVisibleViewport } from "./mobile-viewport.js";
import { Button } from "./ui.js";

/** A cold offline launch exposes only explicitly saved local work. Auth/query
 * data never hydrates from disk and all online mutation paths remain gated. */
export function PwaBootstrap({ children }: PropsWithChildren) {
  useVisibleViewport();
  const [mode, setMode] = useState<"opening" | "online" | "offline" | "signin">("opening");
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const pwa = usePwa();
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/auth/session", { redirect: "error", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error("Sign in again to reconnect.");
        const auth = await response.json() as { storageScope?: string };
        if (!auth.storageScope || !/^[A-Za-z0-9_-]{43}$/.test(auth.storageScope)) throw new Error("Update the gateway before using this app.");
        if (disposed) return;
        await flushDrafts();
        if (disposed) return;
        configureDraftScope(auth.storageScope);
        setMode("online"); setError("");
        void registerPwa();
      } catch (error) {
        if (disposed) return;
        const scope = lastDraftScope();
        if (scope) configureDraftScope(scope);
        setMode(scope ? "offline" : "signin");
        setError(navigator.onLine ? "Reconnect or sign in again. Saved drafts remain on this device." : "You’re offline. Saved drafts remain on this device.");
      }
    })();
    return () => { disposed = true; controller.abort(); };
  }, [retry]);
  useEffect(() => {
    const reconnect = () => { if (mode !== "online") setRetry(value => value + 1); };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [mode]);
  async function signIn() { try { await flushDrafts(); window.location.assign("/" + (location.hash || "#/agents")); } catch { setError("Drafts could not be saved. Review saved work before leaving this page."); } }
  if (mode === "opening") return <p className="p-4 text-sm" role="status">Opening Leo / agents…</p>;
  if (mode !== "online") return <main className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b border-[var(--border-subtle)] p-3"><p className="text-sm text-[var(--text-secondary)]" role="status">{error}</p><div className="mt-2 flex gap-2"><Button onClick={() => setRetry(value => value + 1)}>Reconnect</Button><Button tone="ghost" onClick={() => void signIn()}>Sign in again</Button></div></div>
    {mode === "offline" ? <MobileSettings offline /> : <p className="p-4 text-sm text-[var(--text-secondary)]">Open the workspace online once to save drafts and install the app.</p>}
  </main>;
  return <div className="flex h-full min-h-0 flex-col">
    {pwa.updateAvailable ? <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-1 text-xs" role="status"><span>App update available</span><Button tone="ghost" className="text-xs" onClick={() => void updatePwa().catch(() => setError("Save your drafts before updating."))}>Save and update</Button></div> : null}
    {error ? <p className="px-3 text-sm text-[var(--status-waiting)]" role="alert">{error}</p> : null}
    {children}
  </div>;
}
