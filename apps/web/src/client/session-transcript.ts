import type { NativeEvent } from "@arduano/agent-multiplex-protocol";
import { TranscriptStore } from "./transcript-store.js";
import type { TimelineEntry } from "./transcript.js";

export interface SubagentThread {
  readonly id: string;
  readonly path?: string | undefined;
  readonly nickname?: string | undefined;
  readonly status: "unknown" | "running" | "idle" | "error" | "interrupted";
  readonly store: TranscriptStore;
}

/** The logical stream includes descendants, while native history belongs to
 * one thread. Keep their stores separate before any transcript projection. */
export class SessionTranscript {
  readonly root = new TranscriptStore();
  private readonly children = new Map<string, SubagentThread>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private lastSequence = -1;
  private epoch: string | undefined;
  private interrupted = false;
  constructor(readonly rootThreadId?: string, readonly harness?: string) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly snapshot = (): number => this.revision;
  get threads(): readonly SubagentThread[] { return [...this.children.values()]; }
  get hasGap(): boolean { return this.interrupted; }

  appendHistory(entries: readonly TimelineEntry[]): void {
    for (const entry of entries) this.learnItem(entry.raw);
    this.root.appendHistory(entries);
  }

  applyEvents(events: readonly NativeEvent[]): void {
    const batches = new Map<TranscriptStore, NativeEvent[]>();
    for (const event of events) {
      if (this.epoch !== undefined && event.runtimeEpoch !== this.epoch) continue;
      this.epoch = event.runtimeEpoch;
      if (event.sequence <= this.lastSequence) continue;
      this.lastSequence = event.sequence;
      let target = this.root;
      if (event.harness === "codex") {
        const payload = object(event.payload.json);
        const thread = object(payload?.thread);
        const id = string(payload?.threadId) ?? (event.nativeType === "thread/started" ? string(thread?.id) : undefined);
        // A Codex item without its native thread fence cannot safely be
        // attributed to the parent. Diagnostic notifications have no rows.
        if (!id || !this.rootThreadId) continue;
        this.learnItem(payload?.item);
        if (id !== this.rootThreadId) {
          let child = this.ensure(id);
          const nickname = string(thread?.agentNickname);
          if (nickname) child = this.update(child, { nickname });
          const turn = object(payload?.turn);
          const nativeStatus = object(payload?.status)?.type;
          const status = event.nativeType === "error" && payload?.willRetry !== true ? "error"
            : event.nativeType === "turn/completed" ? turn?.status === "failed" ? "error" : turn?.status === "interrupted" ? "interrupted" : "idle"
            : event.nativeType === "thread/status/changed" ? nativeStatus === "active" ? "running" : nativeStatus === "idle" ? "idle" : nativeStatus === "systemError" ? "error" : "unknown"
            : event.nativeType === "turn/started" || event.nativeType.startsWith("item/") ? "running" : undefined;
          if (status) child = this.update(child, { status });
          target = child.store;
        }
      }
      const batch = batches.get(target) ?? [];
      batch.push(event);
      batches.set(target, batch);
    }
    for (const [target, batch] of batches) target.applyEvents(batch);
  }

  markGap(): void {
    this.interrupted = true;
    for (const child of this.children.values()) this.update(child, { status: "unknown" });
    this.emit();
  }

  private learnItem(raw: unknown): void {
    if (this.harness !== "codex") return;
    const item = object(raw);
    if (item?.type === "subAgentActivity") {
      const id = string(item.agentThreadId);
      if (id && id !== this.rootThreadId) {
        const child = this.ensure(id);
        const path = string(item.agentPath);
        if (path) this.update(child, { path });
      }
    } else if (item?.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)) {
      for (const id of item.receiverThreadIds) if (typeof id === "string" && id && id !== this.rootThreadId) this.ensure(id);
    }
  }
  private ensure(id: string): SubagentThread {
    let child = this.children.get(id);
    if (!child) {
      child = { id, status: "unknown", store: new TranscriptStore() };
      this.children.set(id, child);
      this.emit();
    }
    return child;
  }
  private update(child: SubagentThread, patch: Partial<Pick<SubagentThread, "path" | "nickname" | "status">>): SubagentThread {
    if (Object.entries(patch).every(([key, value]) => child[key as keyof SubagentThread] === value)) return child;
    const next = { ...child, ...patch };
    this.children.set(child.id, next);
    this.emit();
    return next;
  }
  private emit(): void { this.revision++; for (const listener of this.listeners) listener(); }
}

export function subagentLabel(thread: SubagentThread): string {
  const path = thread.path?.replace(/^\/root\//, "");
  return thread.nickname ? path ? `${thread.nickname} · ${path}` : thread.nickname : path ?? `Agent ${thread.id.slice(-8)}`;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
