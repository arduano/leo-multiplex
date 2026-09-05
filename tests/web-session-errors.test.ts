import { describe, expect, it, vi } from "vitest";
import type { NativeEvent } from "@arduano/agent-multiplex-protocol";
import { SessionErrorState, sessionErrorState } from "../apps/web/src/client/session-error-state.js";

function event(sequence: number, nativeType: string, payload: object = {}): NativeEvent {
  return { sequence, nativeType, harness: "codex", runtimeEpoch: "epoch", payload: { json: { threadId: "root", ...payload }, images: [] } } as NativeEvent;
}
const failure = { message: "The model is at capacity.", codexErrorInfo: "serverOverloaded" };

describe("selected session error observations", () => {
  it("surfaces native systemError even when the catalog said idle, without inventing the missing message", () => {
    const state = new SessionErrorState();
    state.observeStatus({ type: "systemError" }, state.generation);
    expect(state.snapshot()?.code).toBe("detailsUnavailable");
    expect(state.snapshot()?.guidance).toContain("Terminal");
  });
  it("keeps a failed turn visible through idle, then clears its banner when a follow-up starts", () => {
    const state = new SessionErrorState();
    state.observe(event(1, "error", { turnId: "a", error: failure, willRetry: true }), "root");
    expect(state.snapshot()?.willRetry).toBe(true);
    state.observe(event(2, "turn/completed", { turn: { id: "a", status: "failed", error: null } }), "root");
    const terminal = state.snapshot();
    expect(terminal?.willRetry).toBe(false);
    expect(terminal?.message).toBe(failure.message);
    expect(terminal?.title).toBe("Model at capacity");
    state.observe(event(3, "thread/status/changed", { status: { type: "idle" } }), "root");
    expect(state.snapshot()).toBe(terminal);
    state.observe(event(4, "turn/started", { turn: { id: "b" } }), "root");
    expect(state.snapshot()).toBeNull();
    state.observe(event(5, "turn/completed", { turn: { id: "b", status: "completed" } }), "root");
    expect(state.snapshot()).toBeNull();
  });
  it("recovers missed starts from current native active status and fences delayed reads", () => {
    const state = new SessionErrorState();
    state.observeStatus({ type: "systemError" }, state.generation);
    const before = state.generation;
    state.observe(event(1, "thread/status/changed", { status: { type: "active", activeFlags: [] } }), "root");
    state.observeStatus({ type: "systemError" }, before);
    expect(state.snapshot()).toBeNull();
    state.observe(event(2, "error", { turnId: "b", error: failure }), "root");
    state.observeStatus({ type: "active" }, before);
    expect(state.snapshot()?.title).toBe("Model at capacity");
    state.observeStatus({ type: "active" }, state.generation);
    expect(state.snapshot()).toBeNull();
  });
  it("ignores a delayed error snapshot after a new turn starts and surfaces any new failure", () => {
    const state = new SessionErrorState();
    state.observe(event(1, "error", { turnId: "a", error: failure }), "root");
    const before = state.generation;
    state.observe(event(2, "turn/started", { turn: { id: "b" } }), "root");
    state.observeStatus({ type: "systemError" }, before);
    state.observe(event(3, "turn/completed", { turn: { id: "a", status: "failed", error: failure } }), "root");
    expect(state.snapshot()).toBeNull();
    state.observe(event(4, "error", { turnId: "b", error: failure }), "root");
    expect(state.snapshot()?.turnId).toBe("b");
  });
  it("drops the old active-turn fence when a native status read recovers work missed during navigation", () => {
    const state = new SessionErrorState();
    state.observe(event(1, "turn/started", { turn: { id: "a" } }), "root");
    state.observe(event(2, "error", { turnId: "a", error: failure }), "root");
    state.observeStatus({ type: "active" }, state.generation);
    state.observe(event(3, "error", { turnId: "b", error: failure }), "root");
    expect(state.snapshot()?.turnId).toBe("b");
  });
  it.each(["item/agentMessage/delta", "item/plan/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta"])("clears a retrying failure on native %s without notifying for every subsequent delta", (type) => {
    const state = new SessionErrorState();
    state.observe(event(1, "turn/started", { turn: { id: "a" } }), "root");
    state.observe(event(2, "error", { turnId: "a", error: failure, willRetry: true }), "root");
    const listener = vi.fn(); state.subscribe(listener);
    const before = state.generation;
    state.observe(event(3, "turn/started", { turn: { id: "a" } }), "root");
    state.observeStatus({ type: "active" }, state.generation);
    expect(state.snapshot()?.willRetry).toBe(true);
    state.observe(event(4, type, { turnId: "a", delta: "Recovered" }), "root");
    state.observeStatus({ type: "systemError" }, before);
    for (let i = 5; i < 1005; i++) state.observe(event(i, type, { turnId: "a", delta: "word" }), "root");
    expect(state.snapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("does not clear for child work, settings, empty deltas, stale events, or late output from a failed turn", () => {
    const state = new SessionErrorState();
    state.observe(event(1, "turn/completed", { turn: { id: "a", status: "failed", error: failure } }), "root");
    const terminal = state.snapshot();
    state.observe(event(2, "turn/started", { threadId: "child", turn: { id: "b" } }), "root");
    state.observe(event(3, "thread/status/changed", { threadId: "child", status: { type: "active" } }), "root");
    state.observe(event(4, "item/agentMessage/delta", { threadId: "child", turnId: "b", delta: "word" }), "root");
    state.observe(event(5, "thread/settings/updated", { threadSettings: { model: "other" } }), "root");
    state.observe(event(6, "item/agentMessage/delta", { turnId: "b", delta: "" }), "root");
    state.observe(event(7, "item/agentMessage/delta", { turnId: "a", delta: "late word" }), "root");
    state.observe(event(1, "turn/started", { turn: { id: "b" } }), "root");
    expect(state.snapshot()).toBe(terminal);
  });
  it("does not let child notifications or delayed snapshots overwrite the root outcome", () => {
    const state = new SessionErrorState();
    const before = state.generation;
    state.observe(event(1, "turn/completed", { turn: { id: "a", status: "completed" } }), "root");
    state.observeStatus({ type: "systemError" }, before);
    state.observe(event(2, "error", { threadId: "child", error: failure }), "root");
    expect(state.snapshot()).toBeNull();
    state.observe(event(3, "error", { turnId: "a", error: failure }), "root");
    state.observe(event(4, "turn/completed", { threadId: "child", turn: { id: "b", status: "completed" } }), "root");
    expect(state.snapshot()?.title).toBe("Model at capacity");
  });
  it("ignores stale old-turn completion and does not notify the composer for deltas", () => {
    const state = new SessionErrorState();
    const listener = vi.fn(); state.subscribe(listener);
    state.observe(event(1, "turn/started", { turn: { id: "new" } }), "root");
    state.observe(event(2, "turn/completed", { turn: { id: "old", status: "failed", error: failure } }), "root");
    for (let i = 3; i < 1003; i++) state.observe(event(i, "item/agentMessage/delta", { itemId: "m", delta: "word" }), "root");
    expect(listener).not.toHaveBeenCalled();
  });
  it("retains a binding's observation across navigation without sharing it with another binding", () => {
    const a = sessionErrorState("a");
    a.observe(event(1, "error", { error: failure }), "root");
    expect(sessionErrorState("a")).toBe(a);
    expect(sessionErrorState("b").snapshot()).toBeNull();
  });
});
