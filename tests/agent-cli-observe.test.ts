import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessClient, AccessWatchCursor } from "@arduano/agent-multiplex-client";
import { accessStreamItemSchema, type AccessStreamItem, type SessionRecord } from "@arduano/agent-multiplex-protocol";
import { observeTurn, streamEvents } from "../apps/agent-cli/src/observe.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const authority = { realmId: id(1), controlNodeId: id(2), epochId: id(3) };
const provenance = { authority, originControlNodeId: id(2) };
const session = { sessionId: id(4), runtimeEpoch: id(5), harness: "codex", vendorSessionId: "root-thread" } as SessionRecord;
const payload = (json: unknown) => ({ encoding: "native-json-images-v1", json, images: [] });
const heartbeat = () => ({ kind: "heartbeat", feedId: id(6), controlCursor: 0, authorityRefs: [authority] } as AccessStreamItem);
const native = (sequence: number, nativeType: string, json: unknown, extra: object = {}) => accessStreamItemSchema.parse({
  kind: "native", sessionId: session.sessionId, runtimeEpoch: session.runtimeEpoch,
  harness: "codex", sequence, nativeType, payload: payload(json), ephemeral: false, provenance, ...extra,
});
const started = (sequence: number, turnId = "target-turn", threadId = session.vendorSessionId) => native(sequence, "turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
const completed = (sequence: number, turnId = "target-turn", status = "completed", error: unknown = null) => native(sequence, "turn/completed", { threadId: session.vendorSessionId, turn: { id: turnId, status, error } });
const message = (sequence: number, text: string, itemId = `message-${sequence}`, turnId = "target-turn") => native(sequence, "item/completed", {
  threadId: session.vendorSessionId, turnId, item: { id: itemId, type: "agentMessage", text },
});
const gap = () => ({ kind: "nativeGap", sessionId: session.sessionId, reason: "fixture gap", recovery: "readNativeHistory", provenance } as AccessStreamItem);

interface Callbacks {
  onData(item: AccessStreamItem): void;
  onError(error: unknown): void;
  onComplete(): void;
  onStarted?(): void;
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function subscription() {
  const controller = new AbortController();
  const calls: Array<{ input: unknown; callbacks: Callbacks; unsubscribe: ReturnType<typeof vi.fn> }> = [];
  const client = { sessions: { watch: { subscribe: (input: unknown, callbacks: Callbacks) => {
    const unsubscribe = vi.fn(); calls.push({ input, callbacks, unsubscribe }); return { unsubscribe };
  } } } } as unknown as AccessClient;
  cleanups.push(() => controller.abort());
  return { client, controller, calls,
    emit(item: AccessStreamItem) { calls.at(-1)!.callbacks.onData(item); },
    error(error: unknown) { calls.at(-1)!.callbacks.onError(error); },
  };
}
function observing() {
  const fixture = subscription();
  const observer = observeTurn(fixture.client, session, { signal: fixture.controller.signal });
  cleanups.push(() => observer.close());
  return { ...fixture, observer };
}

function interaction(sequence: number, state: "pending" | "resolved", params: unknown, extra: object = {}): AccessStreamItem {
  return accessStreamItemSchema.parse({
    kind: "control", eventId: id(100 + sequence), feedId: id(6), cursor: sequence, provenance,
    change: { type: "interaction.changed", interaction: {
      interactionId: id(20), sessionId: session.sessionId, runtimeEpoch: session.runtimeEpoch,
      harness: "codex", requestType: "userInput", payload: payload({ method: "item/tool/requestUserInput", params }),
      ephemeral: false, state, createdAt: "2026-09-05T00:00:00.000Z", expiresAt: null, resolvedAt: state === "resolved" ? "2026-09-05T00:00:01.000Z" : null,
      ...extra,
    } },
  });
}

describe("CLI turn observation", () => {
  it("waits for the heartbeat barrier and buffers a completion before the send acknowledgement", async () => {
    const f = observing();
    let ready = false;
    void f.observer.ready.then(() => { ready = true; });
    f.calls[0]!.callbacks.onStarted?.();
    f.emit(started(0)); f.emit(message(1, "Finished before command acknowledgement.")); f.emit(completed(2));
    await flush();
    expect(ready).toBe(false);
    f.emit(heartbeat()); await f.observer.ready;
    expect(await f.observer.wait("target-turn")).toMatchObject({ state: "completed", turnId: "target-turn", messages: [{ text: "Finished before command acknowledgement." }] });
  });

  it("correlates the exact root turn and epoch, never idle status", async () => {
    const f = observing(); f.emit(heartbeat()); await f.observer.ready;
    let settled = false;
    const waiting = f.observer.wait("target-turn"); void waiting.then(() => { settled = true; });
    f.emit(started(0));
    f.emit(native(1, "thread/status/changed", { threadId: session.vendorSessionId, status: { type: "idle" } }));
    f.emit(completed(2, "other-turn"));
    f.emit(native(3, "turn/completed", { threadId: "child-thread", turn: { id: "target-turn", status: "completed" } }));
    f.emit(native(4, "turn/completed", { threadId: session.vendorSessionId, turn: { id: "target-turn", status: "completed" } }, { runtimeEpoch: id(88) }));
    f.emit(native(5, "turn/completed", { threadId: session.vendorSessionId, turn: { id: "target-turn", status: "completed" } }, { sessionId: id(89) }));
    await flush(); expect(settled).toBe(false);
    f.emit(completed(6)); expect((await waiting).state).toBe("completed");
  });

  it("keeps retrying errors pending and retains native failure details when completion omits them", async () => {
    const f = observing(); f.emit(heartbeat()); await f.observer.ready;
    const waiting = f.observer.wait("target-turn");
    let settled = false; void waiting.then(() => { settled = true; });
    f.emit(started(0));
    f.emit(native(1, "error", { threadId: session.vendorSessionId, turnId: "target-turn", willRetry: true,
      error: { message: "Exact native provider failure", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } }, additionalDetails: "Plain native details" } }));
    await flush(); expect(settled).toBe(false);
    f.emit(completed(2, "target-turn", "failed"));
    expect(await waiting).toMatchObject({ state: "failed", failure: { title: "Rate limit reached", message: "Exact native provider failure", details: "Plain native details", willRetry: false } });
  });

  it("reports nonretrying native failure and distinguishes interruption from success", async () => {
    const f = observing(); f.emit(heartbeat()); await f.observer.ready;
    f.emit(native(0, "error", { threadId: session.vendorSessionId, turnId: "failed-turn", willRetry: false, error: { message: "Usage limit", codexErrorInfo: "usageLimitExceeded" } }));
    f.emit(completed(1, "interrupted-turn", "interrupted"));
    await flush();
    expect(await f.observer.wait("failed-turn")).toMatchObject({ state: "failed", failure: { code: "usageLimitExceeded", willRetry: false } });
    expect(await f.observer.wait("interrupted-turn")).toMatchObject({ state: "interrupted" });
  });

  it("uses matching blocking interactions and removes resolved needsInput state", async () => {
    const f = observing(); f.emit(heartbeat()); await f.observer.ready;
    f.emit(started(0));
    const params = { threadId: session.vendorSessionId, turnId: "target-turn", isBlocking: true };
    f.emit(interaction(1, "pending", params)); await flush();
    expect((await f.observer.wait("target-turn")).state).toBe("needsInput");
    f.emit(interaction(2, "resolved", params)); await flush();
    const waiting = f.observer.wait("target-turn"); let settled = false; void waiting.then(() => { settled = true; });
    f.emit(interaction(3, "pending", { ...params, threadId: "child-thread" }));
    f.emit(interaction(4, "pending", { ...params, isBlocking: false }));
    f.emit(interaction(5, "pending", params, { runtimeEpoch: id(77) }));
    await flush(); expect(settled).toBe(false);
    f.emit(completed(6)); expect((await waiting).state).toBe("completed");
    f.emit(interaction(7, "pending", {})); await flush();
    expect((await f.observer.wait("target-turn")).state).toBe("completed");
  });

  it("does not attach a stale interaction to a different active turn", async () => {
    const f = observing(); f.emit(heartbeat()); await f.observer.ready;
    f.emit(started(0));
    f.emit(interaction(1, "pending", { threadId: session.vendorSessionId, turnId: "previous-turn", isBlocking: true }));
    const waiting = f.observer.wait("target-turn"); let settled = false; void waiting.then(() => { settled = true; });
    await flush(); expect(settled).toBe(false);
    f.emit(completed(2)); expect((await waiting).state).toBe("completed");
  });

  it.each([gap(), { kind: "streamReset", previousFeedId: id(90), feedId: id(6), controlCursor: 0, authorityRefs: [authority], reason: "feedChanged", recovery: "snapshot" } as AccessStreamItem])("rejects readiness when an initial $kind proves a gap", async (item) => {
    const f = observing(); f.emit(item);
    await expect(f.observer.ready).rejects.toMatchObject({ code: "WATCH_GAP" });
    expect(f.calls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    await expect(f.observer.wait("target-turn")).rejects.toMatchObject({ code: "WATCH_GAP" });
  });

  it("reports a post-readiness gap to the pending or future wait and ignores later completion", async () => {
    const f = observing(); f.emit(heartbeat()); await f.observer.ready;
    const waiting = f.observer.wait("target-turn");
    f.emit(gap()); expect((await waiting).state).toBe("gap");
    f.emit(completed(1));
    expect((await f.observer.wait("target-turn")).state).toBe("gap");
    expect(f.calls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN"])("rejects readiness on %s without retrying", async (code) => {
    const f = observing(); const error = Object.assign(new Error("fixture denial"), { data: { code } });
    f.error(error);
    await expect(f.observer.ready).rejects.toBe(error);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects pending readiness and waiters on close or abort and closes idempotently", async () => {
    const beforeReady = observing(); const earlyWait = beforeReady.observer.wait("target-turn");
    beforeReady.observer.close(); beforeReady.observer.close();
    await expect(beforeReady.observer.ready).rejects.toMatchObject({ code: "WATCH_CLOSED" });
    await expect(earlyWait).rejects.toMatchObject({ code: "WATCH_CLOSED" });
    expect(beforeReady.calls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    const live = observing(); live.emit(heartbeat()); await live.observer.ready;
    const waiting = live.observer.wait("target-turn"); const reason = new Error("fixture abort");
    live.controller.abort(reason); await expect(waiting).rejects.toBe(reason);
    expect(live.calls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    const closedLive = observing(); closedLive.emit(heartbeat()); await closedLive.observer.ready;
    const closedWait = closedLive.observer.wait("target-turn"); await flush(); closedLive.observer.close();
    await expect(closedWait).rejects.toMatchObject({ code: "WATCH_CLOSED" });
  });

  it("does not replace an existing waiter", async () => {
    const f = observing(); f.emit(heartbeat()); await f.observer.ready;
    const waiting = f.observer.wait("target-turn");
    await expect(f.observer.wait("other-turn")).rejects.toMatchObject({ code: "WATCH_BUSY" });
    f.emit(completed(0)); expect((await waiting).state).toBe("completed");
  });

  it("deduplicates final message IDs and bounds UTF-8 output without splitting characters", async () => {
    const f = observing(); f.emit(heartbeat()); await f.observer.ready;
    f.emit(message(0, "Old", "same")); f.emit(message(1, "Replacement", "same"));
    f.emit(message(2, "🙂".repeat(20_000), "large")); f.emit(completed(3)); await flush();
    const result = await f.observer.wait("target-turn");
    expect(result.messages).toHaveLength(2); expect(result.messages[0]?.text).toBe("Replacement");
    expect(result.messages[1]?.text).not.toContain("�"); expect(result.truncated).toBe(true);
    expect(result.messages.reduce((total, item) => total + Buffer.byteLength(item.id) + Buffer.byteLength(item.text), 0)).toBeLessThanOrEqual(65_536);
  });

  it("bounds empty messages and turn buffers, reporting lost correlation as a gap", async () => {
    const f = observing(); f.emit(heartbeat()); await f.observer.ready;
    for (let index = 0; index < 300; index++) {
      f.emit(message(index, "")); if (index % 64 === 63) await flush();
    }
    f.emit(completed(300)); await flush();
    const first = await f.observer.wait("target-turn");
    expect(first.messages.length).toBeLessThanOrEqual(256); expect(first.truncated).toBe(true);
    for (let index = 0; index < 70; index++) { f.emit(completed(301 + index, `later-${index}`)); if (index % 32 === 31) await flush(); }
    await flush();
    expect((await f.observer.wait("target-turn")).state).toBe("gap");
    expect((await f.observer.wait("later-69")).state).toBe("completed");
  });
});

describe("CLI event stream output", () => {
  it("honors write backpressure and commits the last written cursor before its maximum", async () => {
    const f = subscription(); let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<{ item: AccessStreamItem; cursor: AccessWatchCursor | undefined }> = [];
    const write = vi.fn(async (item: AccessStreamItem, cursor: AccessWatchCursor | undefined) => { calls.push({ item, cursor }); if (calls.length === 1) await blocked; });
    const running = streamEvents(f.client, session, { signal: f.controller.signal, maximum: 2, write });
    f.emit(heartbeat()); f.emit(message(1, "Retained")); f.emit(message(2, "Not written"));
    await flush(); expect(write).toHaveBeenCalledTimes(1);
    release();
    const result = await running;
    expect(write).toHaveBeenCalledTimes(2); expect(result.count).toBe(2);
    expect(result.cursor?.native[session.sessionId]?.sequence).toBe(1);
    expect(f.calls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("writes a gap once and exits with uncertainty instead of a successful summary", async () => {
    const f = subscription(); const write = vi.fn(async () => undefined);
    const running = streamEvents(f.client, session, { signal: f.controller.signal, maximum: 10, write });
    f.emit(gap());
    await expect(running).rejects.toMatchObject({ code: "STREAM_GAP", exitCode: 5 });
    expect(write).toHaveBeenCalledTimes(1); expect(f.calls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("propagates write errors and unsubscribes", async () => {
    const f = subscription(); const error = new Error("fixture output failure");
    const running = streamEvents(f.client, session, { signal: f.controller.signal, maximum: 2, write: async () => { throw error; } });
    f.emit(heartbeat()); await expect(running).rejects.toBe(error);
    expect(f.calls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("cancels promptly while an output consumer is blocked", async () => {
    const f = subscription(); let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const write = vi.fn(async () => { await blocked; });
    const running = streamEvents(f.client, session, { signal: f.controller.signal, maximum: 2, write });
    f.emit(heartbeat()); await flush(); expect(write).toHaveBeenCalledTimes(1);
    const reason = new Error("fixture blocked-write cancellation"); f.controller.abort(reason);
    await expect(running).rejects.toBe(reason); release();
    expect(f.calls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation and permanent authentication errors", async () => {
    const f = subscription(); const reason = new Error("fixture cancellation");
    const running = streamEvents(f.client, session, { signal: f.controller.signal, maximum: 2, write: async () => undefined });
    f.controller.abort(reason); await expect(running).rejects.toBe(reason);
    const denied = subscription(); const error = { data: { code: "UNAUTHORIZED" } };
    const unauthorized = streamEvents(denied.client, session, { signal: denied.controller.signal, maximum: 2, write: async () => undefined });
    denied.error(error); await expect(unauthorized).rejects.toBe(error); expect(denied.calls).toHaveLength(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid event maximum %s before subscribing", async (maximum) => {
    const f = subscription();
    await expect(streamEvents(f.client, session, { signal: f.controller.signal, maximum, write: async () => undefined })).rejects.toMatchObject({ code: "INVALID_LIMIT" });
    expect(f.calls).toHaveLength(0);
  });
});
