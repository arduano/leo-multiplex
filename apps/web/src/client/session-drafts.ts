import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import { payloadHash } from "@arduano/agent-multiplex-client/browser";
import type { CommandEnvelope, ImageDescriptor } from "@arduano/agent-multiplex-protocol";
import { v4 as randomUUID } from "uuid";
import { DRAFT_BUDGET_BYTES, clearEmptyDocuments, documents, readDocument, removeDocument, writeDocument } from "./draft-storage.js";

export interface DraftImage { id: string; file: File; url: string; descriptor?: ImageDescriptor; binding?: string; }
export interface SessionDraft {
  readonly prompt: string;
  readonly images: DraftImage[];
  readonly uncertain: CommandEnvelope | null;
  readonly uncertainPrompt: string | null;
  readonly saveError: string;
  readonly loaded: boolean;
}
type SavedDraft = Omit<SessionDraft, "saveError" | "loaded" | "images"> & { images: Omit<DraftImage, "url">[] };
interface DraftSlot { id: string; scope: string; value: SessionDraft; revision: number; listeners: Set<() => void>; dirty: boolean; conflicted: boolean; saving: Promise<void>; timer?: ReturnType<typeof setTimeout>; }
const slots = new Map<string, DraftSlot>();
const empty = (): SessionDraft => ({ prompt: "", images: [], uncertain: null, uncertainPrompt: null, saveError: "", loaded: false });
let scope = "";
let changes: BroadcastChannel | undefined;
const listeners = new Set<() => void>();
let generation = 0;
function emit() { generation += 1; for (const listener of listeners) listener(); }
function notify(slot: DraftSlot) { for (const listener of slot.listeners) listener(); emit(); }
function stored(value: SessionDraft): SavedDraft { return { prompt: value.prompt, images: value.images.map(({ url: _url, ...image }) => image), uncertain: value.uncertain, uncertainPrompt: value.uncertainPrompt }; }
function restored(value: SavedDraft): SessionDraft {
  return { ...value, images: value.images.map((image) => ({ ...image, url: URL.createObjectURL(image.file) })), saveError: "", loaded: true };
}
export function configureDraftScope(value: string): void {
  if (!value || scope === value) return;
  scope = value;
  try { localStorage.setItem("leo.drafts.lastScope", value); } catch { /* IndexedDB remains authoritative. */ }
  if (!changes && typeof BroadcastChannel !== "undefined") {
    changes = new BroadcastChannel("leo-local-work");
    changes.onmessage = ({ data }) => {
      if (data?.scope !== scope) return;
      const slot = slots.get(`${scope}:${data.id}`);
      if (slot && !slot.dirty && !slot.conflicted) void hydrate(slot);
      emit();
    };
  }
  emit();
}
export function lastDraftScope(): string | null { try { return localStorage.getItem("leo.drafts.lastScope"); } catch { return null; } }
export function currentDraftScope(): string { if (!scope) throw new Error("Sign in before saving local work"); return scope; }
export const subscribeDrafts = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const draftVersion = () => generation;
async function hydrate(slot: DraftSlot): Promise<void> {
  try {
    const document = await readDocument<SavedDraft>(slot.scope, slot.id);
    if (slot.dirty || slot.conflicted) return;
    for (const image of slot.value.images) URL.revokeObjectURL(image.url);
    slot.revision = document?.revision ?? 0;
    slot.value = document ? restored(document.value) : { ...empty(), loaded: true };
  } catch (error) { slot.value = { ...slot.value, loaded: true, saveError: message(error) }; }
  notify(slot);
}
function slotFor(sessionId: string): DraftSlot {
  const id = `draft:${sessionId}`;
  const key = `${scope}:${id}`;
  let slot = slots.get(key);
  if (!slot) {
    slot = { id, scope, value: empty(), revision: 0, listeners: new Set(), dirty: false, conflicted: false, saving: Promise.resolve() };
    slots.set(key, slot);
    if (scope) void hydrate(slot); else slot.value = { ...empty(), loaded: true, saveError: "Sign in to save drafts on this device" };
  }
  return slot;
}
async function persist(slot: DraftSlot): Promise<void> {
  clearTimeout(slot.timer);
  slot.saving = slot.saving.catch(() => {}).then(async () => {
    if (slot.conflicted) throw new Error(slot.value.saveError);
    if (!slot.dirty) return;
    if (!slot.scope) throw new Error("Sign in before saving local work");
    const value = slot.value;
    try {
      const result = await writeDocument(slot.scope, slot.id, "draft", stored(value), slot.revision, `${slot.id}:conflict:${randomUUID()}`);
      if (result.conflict) {
        slot.conflicted = true;
        slot.dirty = false;
        slot.value = { ...slot.value, saveError: "Another window changed this draft. Your version was saved as a separate draft; reopen it in Device data before continuing." };
        notify(slot);
        throw new Error(slot.value.saveError);
      }
      slot.revision = result.document.revision;
      slot.dirty = slot.value !== value;
      slot.value = { ...slot.value, saveError: "" };
      changes?.postMessage({ scope: slot.scope, id: slot.id });
      notify(slot);
    } catch (error) { slot.value = { ...slot.value, saveError: message(error) }; notify(slot); throw error; }
  });
  await slot.saving;
  if (slot.dirty) await persist(slot);
}
export async function flushDrafts(): Promise<void> { await Promise.all([...slots.values()].filter((slot) => slot.scope === scope).map(persist)); }
export interface DraftSummary { id: string; sessionId: string; prompt: string; imageCount: number; bytes: number; updatedAt: number; uncertain: boolean; conflict: boolean; }
export async function listDrafts(): Promise<DraftSummary[]> {
  return (await documents<SavedDraft>(currentDraftScope())).filter((entry) => entry.kind === "draft" && (entry.value.prompt || entry.value.images.length || entry.value.uncertain)).map((entry) => ({ id: entry.id, sessionId: entry.id.slice(6).split(":conflict:")[0]!, prompt: entry.value.prompt, imageCount: entry.value.images.length, bytes: entry.bytes, updatedAt: entry.updatedAt, uncertain: Boolean(entry.value.uncertain), conflict: entry.id.includes(":conflict:") })).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function readDraft(id: string): Promise<SessionDraft | null> { const entry = await readDocument<SavedDraft>(currentDraftScope(), id); return entry ? restored(entry.value) : null; }
/** Settle only the saved envelope, preserving edits and attachments not submitted by it. */
export async function settleCommandDraft(command: CommandEnvelope, succeeded: boolean): Promise<void> {
  await flushDrafts();
  const commandHash = await payloadHash(command);
  const submittedImages = new Set(await Promise.all((command.images ?? []).map(slot => payloadHash(slot.image))));
  const matches = async (value: SavedDraft | SessionDraft) => value.uncertain?.commandId === command.commandId && (await payloadHash(value.uncertain)) === commandHash;
  const settle = async <T extends SavedDraft | SessionDraft>(value: T): Promise<T> => {
    const images = [];
    for (const image of value.images) {
      if (!(succeeded && ["send", "steer"].includes(command.request.command.type) && image.descriptor && submittedImages.has(await payloadHash(image.descriptor)))) images.push(image);
    }
    return { ...value, prompt: succeeded && value.uncertainPrompt !== null && value.prompt === value.uncertainPrompt ? "" : value.prompt,
      images, uncertain: null, uncertainPrompt: null };
  };
  for (const entry of await documents<SavedDraft>(currentDraftScope())) {
    if (entry.kind !== "draft" || !(await matches(entry.value))) continue;
    const slot = slots.get(`${scope}:${entry.id}`);
    if (slot) {
      if (!(await matches(slot.value))) continue;
      const previous = slot.value;
      const next = await settle(previous);
      if (slot.value !== previous) throw new Error("This draft changed while checking the receipt. Check the original action again.");
      slot.value = next; slot.dirty = true;
      await persist(slot);
      for (const image of previous.images) if (!slot.value.images.includes(image)) URL.revokeObjectURL(image.url);
    } else await writeDocument(scope, entry.id, "draft", await settle(entry.value), entry.revision);
    changes?.postMessage({ scope, id: entry.id }); emit();
  }
}
export async function clearEmptyDeviceData(): Promise<void> {
  await flushDrafts();
  await clearEmptyDocuments(currentDraftScope());
  for (const slot of slots.values()) if (slot.scope === scope && !slot.dirty && !slot.conflicted) await hydrate(slot);
  changes?.postMessage({ scope }); emit();
}
export async function deleteDraft(id: string): Promise<void> {
  const slot = slots.get(`${scope}:${id}`);
  if (slot) { clearTimeout(slot.timer); await slot.saving.catch(() => {}); slot.dirty = false; }
  await removeDocument(currentDraftScope(), id);
  if (slot) { for (const image of slot.value.images) URL.revokeObjectURL(image.url); slot.revision = 0; slot.conflicted = false; slot.value = { ...empty(), loaded: true }; notify(slot); }
  changes?.postMessage({ scope, id }); emit();
}
export async function draftStorageUsage(): Promise<{ bytes: number; budgetBytes: number; drafts: number; operations: number }> {
  const entries = await documents(currentDraftScope());
  return { bytes: entries.reduce((total, entry) => total + entry.bytes, 0), budgetBytes: DRAFT_BUDGET_BYTES, drafts: entries.filter((entry) => entry.kind === "draft").length, operations: entries.filter((entry) => entry.kind === "operation").length };
}
export function useSessionDraft(sessionId: string) {
  const slot = slotFor(sessionId);
  const subscribe = useCallback((listener: () => void) => { slot.listeners.add(listener); return () => { slot.listeners.delete(listener); }; }, [slot]);
  const snapshot = useCallback(() => slot.value, [slot]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const update = useCallback(<K extends keyof SessionDraft>(key: K, action: SetStateAction<SessionDraft[K]>) => {
    const next = typeof action === "function" ? (action as (current: SessionDraft[K]) => SessionDraft[K])(slot.value[key]) : action;
    slot.value = { ...slot.value, [key]: next };
    slot.dirty = true;
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => { void persist(slot).catch(() => {}); }, 180);
    notify(slot);
  }, [slot]);
  return { ...value,
    setPrompt: useCallback((action: SetStateAction<string>) => update("prompt", action), [update]),
    setImages: useCallback((action: SetStateAction<DraftImage[]>) => update("images", action), [update]),
    setUncertainPrompt: useCallback((action: SetStateAction<string | null>) => update("uncertainPrompt", action), [update]),
    setUncertain: useCallback((action: SetStateAction<CommandEnvelope | null>) => update("uncertain", action), [update]),
    save: useCallback(() => persist(slot), [slot]),
  };
}
function message(error: unknown): string { return error instanceof Error ? error.message : "Unable to save local work"; }
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.hidden) void flushDrafts().catch(() => {}); });
