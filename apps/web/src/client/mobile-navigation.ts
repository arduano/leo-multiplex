import { useEffect, useRef, useSyncExternalStore } from "react";
import { sessionIdSchema, type SessionId } from "@arduano/agent-multiplex-protocol";

export type MobileRoute = { readonly page: "agents" } | { readonly page: "settings" } | { readonly page: "session"; readonly sessionId: SessionId };
const navigationEvent = "leo:navigation";
const overlayKey = "leoMobileOverlay";

export function parseMobileRoute(hash: string): MobileRoute {
  if (hash === "#/settings") return { page: "settings" };
  const match = /^#\/agents\/([^/?#]+)$/.exec(hash);
  if (match) {
    try {
      const id = sessionIdSchema.safeParse(decodeURIComponent(match[1]!));
      if (id.success) return { page: "session", sessionId: id.data };
    } catch { /* Malformed links fall back to the agent list. */ }
  }
  return { page: "agents" };
}
export function routeHash(route: MobileRoute): string {
  return route.page === "session" ? `#/agents/${encodeURIComponent(route.sessionId)}` : `#/${route.page}`;
}
export function navigateMobile(route: MobileRoute, replace = false): void {
  const hash = routeHash(route);
  if (window.location.hash === hash) return;
  // Selecting from a sheet replaces its temporary history entry, so Back
  // returns to the underlying list rather than resurrecting a closed dialog.
  const overlay = Boolean(history.state?.[overlayKey]);
  const previousHash = window.location.hash;
  history[replace || overlay ? "replaceState" : "pushState"]({ leoPreviousHash: previousHash, leoCanBackToAgents: !replace && !overlay && (previousHash === "" || previousHash === "#/agents") }, "", hash);
  window.dispatchEvent(new Event(navigationEvent));
}
export function backToAgents(): void {
  if (history.state?.leoCanBackToAgents === true) history.back();
  else navigateMobile({ page: "agents" }, true);
}
function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  window.addEventListener("popstate", listener);
  window.addEventListener(navigationEvent, listener);
  return () => {
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("popstate", listener);
    window.removeEventListener(navigationEvent, listener);
  };
}
export function useMobileRoute(): MobileRoute {
  return parseMobileRoute(useSyncExternalStore(subscribe, () => window.location.hash, () => ""));
}

/** Let Android/browser Back dismiss a Radix layer before leaving its session. */
export function useDismissOnBack(open: boolean, onDismiss: () => void): void {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!open || !isPhoneViewport()) return;
    const marker = `overlay-${Date.now()}-${Math.random()}`;
    const previous = history.state;
    history.pushState({ ...previous, [overlayKey]: marker }, "", window.location.href);
    let traversed = false;
    const onPop = () => {
      if (history.state?.[overlayKey] === marker) return;
      traversed = true;
      dismiss.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!traversed && history.state?.[overlayKey] === marker) history.back();
    };
  }, [open]);
}

export function isPhoneViewport(): boolean {
  return window.innerWidth < 960 || (window.innerWidth < 1280 && window.innerHeight < 500);
}
