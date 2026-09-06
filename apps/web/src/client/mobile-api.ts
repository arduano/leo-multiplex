import { useQuery } from "@tanstack/react-query";
import { v4 as uuid } from "uuid";
import { readyServiceWorker } from "./pwa.js";
import { currentDraftScope, flushDrafts } from "./session-drafts.js";

export interface MobileCategories { completion: boolean; input: boolean; error: boolean }
export interface MobileDevice { id: string; name: string; enabled: boolean; categories: MobileCategories; createdAt: string; lastSeenAt: string }
export interface MobileState { devices: MobileDevice[]; watchedSessionIds: string[]; delivery: { pending: number; lastError?: string } }
export interface MobileConfig { enabled: boolean; publicKey: string; origin: string; storageScope: string }
export async function mobileRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("/api/mobile/" + path, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  if (response.status === 401 || response.status === 403) throw new Error("Sign in again before changing notification settings.");
  if (!response.ok) throw new Error(response.status === 503 ? "Notifications are not available on this gateway yet." : "Notification settings could not be saved. Try again.");
  return response.json() as Promise<T>;
}
export function useMobileState(enabled = true) { return useQuery({ queryKey: ["mobile-state"], enabled, queryFn: () => mobileRequest<MobileState>("state"), retry: false, staleTime: 30_000 }); }
export function toggleWatched(sessionId: string, watched: boolean) { return mobileRequest<{ watchedSessionIds: string[] }>(`watches/${encodeURIComponent(sessionId)}`, "PUT", { watched }); }
function deviceKey() { return `leo.push.device.${currentDraftScope()}`; }
export function currentDeviceId(): string | null { try { return localStorage.getItem(deviceKey()); } catch { return null; } }
const defaultCategories = { completion: true, input: true, error: true };
export async function enableNotifications(name: string, categories = defaultCategories): Promise<void> {
  if (!("Notification" in window) || !("PushManager" in window)) throw new Error("Use Chrome on Android to enable notifications.");
  // Permission stays inside the explicit user action, before unrelated awaits.
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked. Allow them in Chrome’s site settings, then try again.");
  const config = await mobileRequest<MobileConfig>("config");
  if (!config.enabled) throw new Error(`Open ${config.origin} to enable notifications.`);
  const registration = await readyServiceWorker();
  const key = Uint8Array.from(atob(config.publicKey.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
  let existing = await registration.pushManager.getSubscription();
  if (existing?.options.applicationServerKey && String(new Uint8Array(existing.options.applicationServerKey)) !== String(key)) {
    if (!await existing.unsubscribe()) throw new Error("Remove the old notification subscription in Chrome site settings, then try again.");
    existing = null;
  }
  const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const id = currentDeviceId() ?? uuid();
  // Persist identity before registration, so a lost reply never creates another device.
  localStorage.setItem(deviceKey(), id);
  await mobileRequest(`devices/${id}`, "PUT", { name, subscription: subscription.toJSON(), enabled: true, categories });
}
export async function saveDeviceSettings(device: MobileDevice): Promise<void> {
  if (device.id !== currentDeviceId()) throw new Error("Change notification categories on that device, or revoke it here.");
  const subscription = await (await readyServiceWorker()).pushManager.getSubscription();
  if (!subscription) throw new Error("Enable notifications again on this device.");
  await mobileRequest(`devices/${device.id}`, "PUT", { name: device.name, categories: device.categories, enabled: device.enabled, subscription: subscription.toJSON() });
}
export async function revokeDevice(id: string): Promise<void> {
  await mobileRequest(`devices/${id}`, "DELETE");
  if (id === currentDeviceId()) {
    if ("serviceWorker" in navigator) await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription().then(value => value?.unsubscribe());
    localStorage.removeItem(deviceKey());
  }
}
export async function signOutMobile(): Promise<void> {
  await flushDrafts();
  const id = currentDeviceId();
  if (id) await revokeDevice(id);
  window.location.href = "/cdn-cgi/access/logout";
}
