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
  it("keeps an error through idle/start until successful completion, respecting native auto retry", () => {
    const state = new SessionErrorState();
    state.observe(event(1, "error", { turnId: "a", error: failure, willRetry: true }), "root");
    expect(state.snapshot()?.willRetry).toBe(true);
    state.observe(event(2, "turn/completed", { turn: { id: "a", status: "failed", error: null } }), "root");
    const terminal = state.snapshot();
    expect(terminal?.willRetry).toBe(false);
    expect(terminal?.message).toBe(failure.message);
    expect(terminal?.title).toBe("Model at capacity");
    state.observe(event(3, "thread/status/changed", { status: { type: "idle" } }), "root");
    state.observe(event(4, "turn/started", { turn: { id: "b" } }), "root");
    expect(state.snapshot()).toBe(terminal);
    state.observe(event(5, "turn/completed", { turn: { id: "b", status: "completed" } }), "root");
    expect(state.snapshot()).toBeNull();
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
