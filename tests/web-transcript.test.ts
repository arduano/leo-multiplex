import { describe, expect, it, vi } from "vitest";
import type { NativeEvent, SessionRecord } from "@arduano/agent-multiplex-protocol";
import type { AccessClient } from "@arduano/agent-multiplex-client/browser";
import { TranscriptStore } from "../apps/web/src/client/transcript-store.js";
import { type TimelineEntry } from "../apps/web/src/client/transcript.js";
import { NativeHistoryPager, advanceNativeHistorySignal, retryNativeHistory } from "../apps/web/src/client/native-history.js";

const entry = (id: string, body = id): TimelineEntry => ({ id: `codex:${id}`, kind: "assistant", title: "Codex", body, raw: {}, pending: false });
const event = (sequence: number, nativeType: string, json: unknown): NativeEvent => ({
  kind: "native", harness: "codex", runtimeEpoch: "epoch", sequence, nativeType, payload: { json, images: [] },
} as NativeEvent);
const session = { sessionId: "session", harness: "codex" } as SessionRecord;

describe("indexed transcript", () => {
  it("retains 100,000 ordered items and updates a single live item without replacing settled row identities", () => {
    const store = new TranscriptStore();
    for (let page = 0; page < 1_000; page += 1) store.appendHistory(Array.from({ length: 100 }, (_, index) => entry(String(page * 100 + index))));
    const first = store.at(0);
    const middle = store.at(50_000);
    const listener = vi.fn(); store.subscribe(listener);
    store.applyEvents(Array.from({ length: 500 }, (_, sequence) => event(sequence, "item/agentMessage/delta", { itemId: "stream", delta: "x" })));
    expect(store.count).toBe(100_001);
    expect(store.at(0)).toBe(first);
    expect(store.at(50_000)).toBe(middle);
    expect(store.at(100_000)?.body).toBe("x".repeat(500));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps native pagination order, moves matching live IDs once, and fences terminal items from stale deltas", () => {
    const store = new TranscriptStore();
    store.applyEvents([event(1, "item/agentMessage/delta", { itemId: "c", delta: "stream" })]);
    store.appendHistory([entry("a"), entry("b"), entry("c", "complete")]);
    store.applyEvents([event(2, "item/agentMessage/delta", { itemId: "c", delta: "stale" })]);
    expect([0, 1, 2].map((index) => store.at(index)?.id)).toEqual(["codex:a", "codex:b", "codex:c"]);
    expect(store.count).toBe(3);
    expect(store.get("codex:c")?.body).toBe("complete");
    expect(store.ordering).toBeGreaterThan(0);
  });

  it("does not append replayed deltas and preserves images across live updates", () => {
    const store = new TranscriptStore();
    const delta = event(1, "item/agentMessage/delta", { itemId: "x", delta: "first" });
    store.applyEvents([delta, delta]);
    expect(store.at(0)?.body).toBe("first");
    store.appendHistory([{ ...entry("x"), images: [{ path: "/retained.png" }] }]);
    store.applyEvents([event(2, "item/completed", { item: { id: "x", type: "agentMessage", text: "done" } })]);
    expect(store.at(0)?.images).toEqual([{ path: "/retained.png" }]);
  });

  it("does not mistake a prior identical prompt for acknowledgment of a new command", () => {
    const store = new TranscriptStore();
    store.appendHistory([{ ...entry("old", "Again"), kind: "user", timestamp: "2026-01-01T00:00:00Z" }]);
    store.addLocal({ ...entry("local", "Again"), id: "local:command", kind: "user", timestamp: "2026-01-02T00:00:00Z", pending: true });
    expect(store.count).toBe(2);
    store.appendHistory([{ ...entry("new", "Again"), kind: "user", timestamp: "2026-01-03T00:00:00Z" }]);
    expect(store.count).toBe(2);
    expect(store.get("local:command")).toBeUndefined();
  });

  it("requires a fresh native echo when old paginated prompts have no timestamps", () => {
    const store = new TranscriptStore();
    store.appendHistory([{ ...entry("old", "Again"), kind: "user" }]);
    store.addLocal({ ...entry("local", "Again"), id: "local:command", kind: "user", pending: true });
    store.appendHistory([{ ...entry("older", "Again"), kind: "user" }]);
    expect(store.get("local:command")).toBeDefined();
    store.applyEvents([event(1, "item/started", { item: { id: "new", type: "userMessage", content: [{ type: "text", text: "Again" }] } })]);
    expect(store.get("local:command")).toBeUndefined();
    expect(store.count).toBe(3);
  });
});

describe("native history pages", () => {
  it("loads on demand beyond 100 pages and reconciles only its terminal cursor", async () => {
    const read = vi.fn(async (input: { request: { cursor?: string } }) => {
      const page = Number(input.request.cursor ?? 0);
      return { harness: "codex", payload: { json: { data: [{ item: { id: `item-${page}`, type: "agentMessage", text: String(page) } }] }, images: [] }, complete: page === 120, ...(page < 120 ? { nextCursor: String(page + 1) } : {}) };
    });
    const client = { sessions: { readNativeHistory: { query: read } } } as unknown as AccessClient;
    const pager = new NativeHistoryPager(client, session);
    const controller = new AbortController();
    expect(read).not.toHaveBeenCalled();
    await pager.next(controller.signal);
    expect(read).toHaveBeenCalledTimes(1);
    for (let index = 1; index <= 120; index += 1) await pager.next(controller.signal);
    expect(pager.done).toBe(true);
    pager.reconcile();
    await pager.next(controller.signal);
    expect(read.mock.calls.at(-1)?.[0].request.cursor).toBe("120");
  });

  it("rejects repeated cursors and checks cancellation before any native request", async () => {
    const query = vi.fn(async () => ({ harness: "codex", payload: { json: { data: [] }, images: [] }, complete: false, nextCursor: "same" }));
    const pager = new NativeHistoryPager({ sessions: { readNativeHistory: { query } } } as unknown as AccessClient, session);
    const controller = new AbortController();
    await pager.next(controller.signal);
    await expect(pager.next(controller.signal)).rejects.toThrow("repeated its cursor");
    controller.abort();
    await expect(pager.next(controller.signal)).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(2);
    const read = vi.fn();
    await expect(retryNativeHistory(read, { active: () => false })).rejects.toThrow("cancelled");
    expect(read).not.toHaveBeenCalled();
  });

  it("retries unavailable initial history at lifecycle boundaries without replaying successful reads", () => {
    const initial = advanceNativeHistorySignal(null, "binding", false, "lifecycle");
    expect(initial?.generation).toBe(1);
    expect(advanceNativeHistorySignal(initial, "binding", false, "lifecycle")?.generation).toBe(2);
    expect(advanceNativeHistorySignal(initial, "binding", true, "lifecycle")).toBe(initial);
    expect(advanceNativeHistorySignal(initial, "binding", true, "reconcile")?.generation).toBe(2);
  });
});
