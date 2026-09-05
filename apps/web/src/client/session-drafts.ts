import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import type { CommandEnvelope, ImageDescriptor } from "@arduano/agent-multiplex-protocol";

export interface DraftImage { id: string; file: File; url: string; descriptor?: ImageDescriptor; }
interface SessionDraft {
  readonly prompt: string;
  readonly images: DraftImage[];
  readonly uncertain: CommandEnvelope | null;
  readonly uncertainPrompt: string | null;
}
interface DraftSlot {
  value: SessionDraft;
  listeners: Set<() => void>;
}

// Drafts outlive the selected transcript without mounting inactive conversations.
// They stay in this tab's memory: prompts, images and command envelopes are never
// written to browser storage. Binding keys prevent retries against a new runtime.
const slots = new Map<string, DraftSlot>();
function slotFor(binding: string): DraftSlot {
  let slot = slots.get(binding);
  if (!slot) {
    slot = { value: { prompt: "", images: [], uncertain: null, uncertainPrompt: null }, listeners: new Set() };
    slots.set(binding, slot);
  }
  return slot;
}

export function useSessionDraft(binding: string) {
  const slot = slotFor(binding);
  const subscribe = useCallback((listener: () => void) => {
    slot.listeners.add(listener);
    return () => { slot.listeners.delete(listener); };
  }, [slot]);
  const snapshot = useCallback(() => slot.value, [slot]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const update = useCallback(<K extends keyof SessionDraft>(key: K, action: SetStateAction<SessionDraft[K]>) => {
    const next = typeof action === "function"
      ? (action as (current: SessionDraft[K]) => SessionDraft[K])(slot.value[key])
      : action;
    slot.value = { ...slot.value, [key]: next };
    for (const listener of slot.listeners) listener();
  }, [slot]);
  return {
    ...value,
    setPrompt: useCallback((action: SetStateAction<string>) => update("prompt", action), [update]),
    setImages: useCallback((action: SetStateAction<DraftImage[]>) => update("images", action), [update]),
    setUncertainPrompt: useCallback((action: SetStateAction<string | null>) => update("uncertainPrompt", action), [update]),
    setUncertain: useCallback((action: SetStateAction<CommandEnvelope | null>) => update("uncertain", action), [update]),
  };
}
