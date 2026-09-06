import { describe, expect, it, vi } from "vitest";
import type { NativeEvent, SessionRecord } from "@arduano/agent-multiplex-protocol";
import type { AccessClient } from "@arduano/agent-multiplex-client/browser";
import { TranscriptStore } from "../apps/web/src/client/transcript-store.js";
import { codexItemId, entriesFromHistory, type TimelineEntry } from "../apps/web/src/client/transcript.js";
import { NativeHistoryPager, advanceNativeHistorySignal, retryNativeHistory } from "../apps/web/src/client/native-history.js";

const entry = (id: string, body = id): TimelineEntry => ({ id: codexItemId(id), kind: "assistant", title: "Codex", body, raw: {}, pending: false });
const event = (sequence: number, nativeType: string, json: unknown): NativeEvent => ({
  kind: "native", harness: "codex", runtimeEpoch: "epoch", sequence, nativeType, payload: { json, images: [] },
} as NativeEvent);
const session = { sessionId: "session", harness: "codex" } as SessionRecord;

describe("indexed transcript", () => {
  it("omits empty reasoning from display indexing while retaining native snapshots and replay protection", () => {
    const store = new TranscriptStore();
    const hidden = { ...entry("reasoning", " \n"), kind: "reasoning" as const };
    store.appendHistory([entry("first"), hidden, entry("last")]);
    expect(store.count).toBe(2);
    expect(store.historyCount).toBe(2);
    expect(store.get(hidden.id)).toMatchObject(hidden);
    expect(store.indexOf(hidden.id)).toBe(-1);
    store.applyEvents([event(1, "item/reasoning/summaryTextDelta", { itemId: "reasoning", delta: "stale replay" })]);
    expect(store.count).toBe(2);
    expect(store.at(1)?.body).toBe("last");
  });

  it("reveals streamed reasoning in its original native position and promotes it into history once", () => {
    const store = new TranscriptStore();
    store.applyEvents([
      event(1, "item/started", { item: { type: "reasoning", id: "reasoning", summary: [], content: [] } }),
      event(2, "item/started", { item: { type: "commandExecution", id: "tool", command: "inspect", aggregatedOutput: "", status: "inProgress" } }),
    ]);
    expect(store.count).toBe(1);
    store.applyEvents([event(3, "item/reasoning/summaryTextDelta", { itemId: "reasoning", delta: "Disclosed summary" })]);
    expect([store.at(0)?.kind, store.at(1)?.kind]).toEqual(["reasoning", "tool"]);
    store.appendHistory([{ ...entry("reasoning", "Disclosed summary"), kind: "reasoning" }, { ...entry("tool", ""), kind: "tool" }]);
    expect(store.count).toBe(2);
    expect(store.historyCount).toBe(2);
    expect(store.at(0)?.body).toBe("Disclosed summary");
  });

  it("reveals reasoning from a historical empty snapshot without shifting it to the live tail", () => {
    const store = new TranscriptStore();
    store.appendHistory([entry("before"), { ...entry("reasoning", ""), kind: "reasoning", pending: undefined, historySnapshot: true }, entry("after")]);
    store.applyEvents([
      event(1, "item/started", { item: { type: "reasoning", id: "reasoning", summary: [], content: [] } }),
      event(2, "item/reasoning/summaryTextDelta", { itemId: "reasoning", delta: "Native summary" }),
    ]);
    expect([0, 1, 2].map((index) => store.at(index)?.body)).toEqual(["before", "Native summary", "after"]);
    expect(store.ordering).toBeGreaterThan(0);
  });

  it("retains failed reasoning, images and disclosed summaries without model-specific assumptions", () => {
    const store = new TranscriptStore();
    store.appendHistory([
      { ...entry("failed", ""), kind: "reasoning", status: "failed" },
      { ...entry("image", ""), kind: "reasoning", images: [{ path: "/disposable.png" }] },
      { ...entry("summary", "Actual summary"), kind: "reasoning" },
    ]);
    expect(store.count).toBe(3);
  });

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
    expect([0, 1, 2].map((index) => store.at(index)?.id)).toEqual(["a", "b", "c"].map((id) => codexItemId(id)));
    expect(store.count).toBe(3);
    expect(store.get(codexItemId("c"))?.body).toBe("complete");
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

describe("Codex thread ownership and snapshot hydration", () => {
  const history = (text: string, { threadId = "root", turnId = "turn", itemId = "message", terminal = false } = {}) => entriesFromHistory({
    harness: "codex", vendorSessionId: threadId, complete: true,
    payload: { encoding: "native-json-images-v1", images: [], json: terminal
      ? { thread: { id: threadId, turns: [{ id: turnId, status: "completed", items: [{ type: "agentMessage", id: itemId, phase: "commentary", text }] }] } }
      : { data: [{ turnId, item: { type: "agentMessage", id: itemId, phase: "commentary", text } }] } },
  });
  const started = (sequence: number, threadId = "root", turnId = "turn", itemId = "message") => event(sequence, "item/started", {
    threadId, turnId, item: { type: "agentMessage", id: itemId, text: "", phase: "commentary" },
  });
  const delta = (sequence: number, text: string, threadId = "root", turnId = "turn", itemId = "message") => event(sequence, "item/agentMessage/delta", {
    threadId, turnId, itemId, delta: text,
  });
  const completed = (sequence: number, text: string, threadId = "root", turnId = "turn", itemId = "message") => event(sequence, "item/completed", {
    threadId, turnId, item: { type: "agentMessage", id: itemId, text, phase: "commentary" },
  });

  it("uses unambiguous native thread and turn identity for live and historical items", () => {
    const store = new TranscriptStore();
    store.appendHistory(history("Root", { terminal: true }));
    store.applyEvents([started(1, "child"), delta(2, "Child", "child"), started(3, "root", "next"), delta(4, "Next", "root", "next")]);
    expect(store.count).toBe(3);
    expect(store.at(0)).toMatchObject({ id: codexItemId("message", "root", "turn"), threadId: "root", turnId: "turn", nativeItemId: "message", body: "Root" });
    expect(store.at(1)).toMatchObject({ threadId: "child", turnId: "turn", body: "Child" });
    expect(store.at(2)).toMatchObject({ threadId: "root", turnId: "next", body: "Next" });
    expect(codexItemId("c", "a:b", "c")).not.toBe(codexItemId("c", "a", "b:c"));
    expect(codexItemId("c", "null", "turn")).not.toBe(codexItemId("c", undefined, "turn"));
  });

  it("preserves child message position without merging later root or reused-turn content", () => {
    const store = new TranscriptStore();
    store.applyEvents([started(1, "child"), started(2, "root"), delta(3, "Child reply", "child"), delta(4, "Root reply")]);
    expect(store.count).toBe(2);
    expect(store.at(0)?.body).toBe("Child reply");
    expect(store.at(1)?.body).toBe("Root reply");
  });

  it("never appends retained replay to completed historical commentary", () => {
    const store = new TranscriptStore();
    store.appendHistory(history("Old commentary"));
    store.applyEvents([delta(1, "Old commentary"), delta(2, " late replay")]);
    expect(store.at(0)?.body).toBe("Old commentary");
    expect(store.at(0)?.pending).toBeUndefined();
    store.applyEvents([completed(3, "Old commentary")]);
    store.applyEvents([delta(4, "stale"), started(5)]);
    expect(store.at(0)).toMatchObject({ body: "Old commentary", pending: false });
  });

  it("resumes a snapshotted active message when a known replay prefix catches up", () => {
    const store = new TranscriptStore();
    store.appendHistory(history("In progress"));
    store.applyEvents([started(1), delta(2, "In ")]);
    expect(store.at(0)?.body).toBe("In progress");
    store.applyEvents([delta(3, "progress and continuing")]);
    expect(store.at(0)).toMatchObject({ body: "In progress and continuing", pending: true });
    store.applyEvents([delta(4, " normally")]);
    expect(store.at(0)?.body).toBe("In progress and continuing normally");
    store.applyEvents([completed(5, "Finished")]);
    expect(store.at(0)).toMatchObject({ body: "Finished", pending: false });
  });

  it("keeps streaming when history arrives after the live start", () => {
    const store = new TranscriptStore();
    store.applyEvents([started(1), delta(2, "Known stream")]);
    store.appendHistory(history("Known"));
    store.applyEvents([delta(3, " continues")]);
    expect(store.count).toBe(1);
    expect(store.historyCount).toBe(1);
    expect(store.at(0)).toMatchObject({ body: "Known stream continues", pending: true });
    store.appendHistory(history("Known stream continues", { terminal: true }));
    store.applyEvents([delta(4, "stale")]);
    expect(store.at(0)).toMatchObject({ body: "Known stream continues", pending: false });
  });

  it("holds an ambiguous mid-stream snapshot until authoritative completion without freezing later items", () => {
    const store = new TranscriptStore();
    store.applyEvents([delta(1, "unknown suffix")]);
    store.appendHistory(history("Snapshot so far"));
    store.applyEvents([delta(2, " might overlap"), started(3, "root", "turn", "next-message"), delta(4, "New live text", "root", "turn", "next-message")]);
    expect(store.at(0)?.body).toBe("Snapshot so far");
    expect(store.at(1)).toMatchObject({ body: "New live text", pending: true });
    store.applyEvents([completed(5, "Authoritative full message")]);
    expect(store.at(0)).toMatchObject({ body: "Authoritative full message", pending: false });
  });

  it("does not revive completion when a delayed active snapshot arrives", () => {
    const store = new TranscriptStore();
    store.applyEvents([completed(1, "Finished commentary")]);
    store.appendHistory(history("Partial snapshot"));
    store.applyEvents([delta(2, "late")]);
    expect(store.at(0)).toMatchObject({ body: "Finished commentary", pending: false });
    expect(store.count).toBe(1);
  });

  it("uses the authoritative terminal turn status without mistaking phase for completion", () => {
    const flat = history("Unknown lifecycle");
    const complete = history("Completed commentary", { terminal: true });
    expect(flat[0]).toMatchObject({ historySnapshot: true });
    expect(flat[0]?.pending).toBeUndefined();
    expect(complete[0]).toMatchObject({ pending: false, historySnapshot: false });
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
