import type { NativeEvent } from "@arduano/agent-multiplex-protocol";
import type { TranscriptImage } from "./image-media.js";
import { projectNativeEvent, type TimelineEntry } from "./transcript.js";

interface RowViewState { readonly expanded?: boolean; readonly page?: number | null; }
/** Ordered native pages and live items share stable IDs. A delta touches one
 * entry; subscribers receive one notification for the entire stream frame. */
export class TranscriptStore {
  private readonly entries = new Map<string, TimelineEntry>();
  private readonly historyIds: string[] = [];
  private readonly historySet = new Set<string>();
  private readonly liveIds: string[] = [];
  private readonly localIds: string[] = [];
  private readonly assets = new Map<string, TranscriptImage>();
  private readonly assetUsers = new Map<string, Set<string>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private liveRevision = 0;
  private orderRevision = 0;
  private readonly lastSequence = new Map<string, number>();
  private readonly rowViews = new Map<string, RowViewState>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly snapshot = (): number => this.version;
  get count(): number { return this.historyIds.length + this.liveIds.length + this.localIds.length; }
  get activity(): number { return this.liveRevision; }
  get ordering(): number { return this.orderRevision; }
  get historyCount(): number { return this.historyIds.length; }
  get(id: string): TimelineEntry | undefined { return this.entries.get(id); }
  view(id: string): RowViewState | undefined { return this.rowViews.get(id); }
  rememberView(id: string, update: RowViewState): void { this.rowViews.set(id, { ...this.rowViews.get(id), ...update }); }
  at(index: number): TimelineEntry | undefined {
    const id = index < this.historyIds.length ? this.historyIds[index]
      : index < this.historyIds.length + this.liveIds.length ? this.liveIds[index - this.historyIds.length]
      : this.localIds[index - this.historyIds.length - this.liveIds.length];
    return id ? this.entries.get(id) : undefined;
  }
  indexOf(id: string): number {
    // Only used for explicit scroll anchors, never on delta or composer edits.
    const history = this.historyIds.indexOf(id);
    if (history >= 0) return history;
    const live = this.liveIds.indexOf(id);
    if (live >= 0) return this.historyIds.length + live;
    const local = this.localIds.indexOf(id);
    return local < 0 ? -1 : this.historyIds.length + this.liveIds.length + local;
  }
  appendHistory(page: readonly TimelineEntry[]): void {
    const previousHistoryCount = this.historyIds.length;
    const hadTail = this.liveIds.length + this.localIds.length > 0;
    const moved = new Set<string>();
    for (const entry of page) {
      if (!this.historySet.has(entry.id)) {
        this.historySet.add(entry.id);
        this.historyIds.push(entry.id);
        if (this.entries.has(entry.id)) moved.add(entry.id);
      }
      this.put(entry, true);
    }
    if (moved.size) {
      let write = 0;
      for (const id of this.liveIds) if (!moved.has(id)) this.liveIds[write++] = id;
      this.liveIds.length = write;
    }
    if (moved.size || hadTail && previousHistoryCount !== this.historyIds.length) this.orderRevision += 1;
    this.emit();
  }
  applyEvents(events: readonly NativeEvent[]): void {
    let changed = false;
    for (const event of events) {
      if (event.sequence <= (this.lastSequence.get(event.runtimeEpoch) ?? -1)) continue;
      this.lastSequence.set(event.runtimeEpoch, event.sequence);
      for (const entry of projectNativeEvent(event, (id) => this.entries.get(id))) {
        if (!this.entries.has(entry.id)) this.liveIds.push(entry.id);
        this.put(entry);
        changed = true;
      }
    }
    if (changed) { this.liveRevision += 1; this.emit(); }
  }
  addLocal(entry: TimelineEntry): void {
    if (this.entries.has(entry.id)) return;
    this.entries.set(entry.id, entry);
    this.localIds.push(entry.id);
    this.liveRevision += 1;
    this.emit();
  }
  private put(incoming: TimelineEntry, fromHistory = false): void {
    const previous = this.entries.get(incoming.id);
    const keepTerminal = previous?.pending === false && incoming.pending === true;
    let entry: TimelineEntry = keepTerminal ? previous : {
      ...previous, ...incoming,
      body: incoming.body || previous?.body || "",
      images: incoming.images ?? previous?.images,
    };
    if (entry.images) entry = { ...entry, images: entry.images.map((image) => {
      if (!image.nativeAssetId) return image;
      const users = this.assetUsers.get(image.nativeAssetId) ?? new Set<string>();
      users.add(entry.id);
      this.assetUsers.set(image.nativeAssetId, users);
      const retained = this.assets.get(image.nativeAssetId);
      return retained?.image ? { ...image, image: retained.image } : image;
    }) };
    this.entries.set(entry.id, entry);
    const raw = entry.raw as { type?: unknown; data?: { assetId?: unknown } } | null;
    if (raw?.type === "session.binary_asset" && typeof raw.data?.assetId === "string") {
      const retained = entry.images?.find((image) => image.image && !("unavailable" in image.image));
      if (retained) {
        this.assets.set(raw.data.assetId, retained);
        for (const id of this.assetUsers.get(raw.data.assetId) ?? []) {
          const ref = this.entries.get(id)!;
          this.entries.set(id, { ...ref, images: ref.images?.map((image) => image.nativeAssetId === raw.data!.assetId
            ? { ...image, image: retained.image! } : image) });
        }
      }
    }
    if (entry.kind === "user") {
      for (let i = this.localIds.length - 1; i >= 0; i -= 1) {
        const local = this.entries.get(this.localIds[i]!)!;
        // Oldest-first pages can predate a just-sent identical prompt. Without
        // native time evidence, only a fresh stream echo can acknowledge it.
        if (fromHistory && (!entry.timestamp || previous)) continue;
        if (sameUser(local, entry)) { this.entries.delete(local.id); this.localIds.splice(i, 1); this.orderRevision += 1; }
      }
    }
  }
  private emit(): void { this.version += 1; for (const listener of this.listeners) listener(); }
}

function sameUser(left: TimelineEntry, right: TimelineEntry): boolean {
  if (left.kind !== "user" || right.kind !== "user" || left.body !== right.body) return false;
  // A prior identical prompt does not acknowledge a newly dispatched command.
  if (left.timestamp && right.timestamp && right.timestamp < left.timestamp) return false;
  const leftImages = left.images ?? [];
  const rightImages = right.images ?? [];
  return leftImages.length === rightImages.length && leftImages.every((image, index) => {
    const other = rightImages[index]?.image;
    return image.image && !("unavailable" in image.image) && other && !("unavailable" in other) && image.image.sha256 === other.sha256;
  });
}
