import { useSyncExternalStore } from "react";
import { flushDrafts } from "./session-drafts.js";

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }
interface PwaState { installed: boolean; installable: boolean; updateAvailable: boolean; ready: boolean; error: string }
let state: PwaState = { installed: window.matchMedia("(display-mode: standalone)").matches, installable: false, updateAvailable: false, ready: false, error: "" };
const listeners = new Set<() => void>();
let deferredInstall: InstallPrompt | null = null;
let registration: ServiceWorkerRegistration | null = null;
let activationRequested = false;
const update = (value: Partial<PwaState>) => { state = { ...state, ...value }; for (const listener of listeners) listener(); };
export function usePwa() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state); }
export async function installPwa(): Promise<void> {
  if (!deferredInstall) return;
  const prompt = deferredInstall; deferredInstall = null; update({ installable: false });
  await prompt.prompt(); await prompt.userChoice;
}
export async function updatePwa(): Promise<void> {
  await flushDrafts();
  if (!registration?.waiting) return;
  activationRequested = true;
  registration.waiting.postMessage({ type: "LEO_ACTIVATE_UPDATE" });
}
export async function readyServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) throw new Error("Open the HTTPS workspace to install the app and enable notifications.");
  if (!registration) await registerPwa();
  return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("App installation is not ready. Reconnect and try again.")), 15_000))]);
}
export async function registerPwa(): Promise<void> {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV) return;
  try {
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    update({ ready: Boolean(registration.active), updateAvailable: Boolean(registration.waiting) });
    registration.addEventListener("updatefound", () => {
      const worker = registration?.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed") update({ ready: true, updateAvailable: Boolean(registration?.waiting && navigator.serviceWorker.controller) });
      });
    });
  } catch { update({ error: "Offline installation is unavailable. Reconnect and reopen the app to try again." }); }
}
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredInstall = event as InstallPrompt; update({ installable: true }); });
window.addEventListener("appinstalled", () => { deferredInstall = null; update({ installed: true, installable: false }); });
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    update({ ready: true });
    if (activationRequested) window.location.reload();
  });
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.source !== navigator.serviceWorker.controller) return;
    if (event.data?.type === "LEO_NAVIGATE" && typeof event.data.hash === "string" && /^#\/agents(?:\/[0-9a-f-]{36})?$/.test(event.data.hash)) window.location.hash = event.data.hash;
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void registration?.update().catch(() => {}); });
}
