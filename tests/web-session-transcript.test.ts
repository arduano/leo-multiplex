import { describe, expect, it, vi } from "vitest";
import type { NativeEvent } from "@arduano/agent-multiplex-protocol";
import { SessionTranscript, subagentLabel } from "../apps/web/src/client/session-transcript.js";
import { NativeHistoryPager } from "../apps/web/src/client/native-history.js";
import { entriesFromHistory } from "../apps/web/src/client/transcript.js";

const event = (sequence: number, threadId: string | undefined, nativeType: string, payload: object = {}): NativeEvent => ({
  kind: "native", harness: "codex", runtimeEpoch: "epoch", sequence, nativeType,
  payload: { json: { threadId, turnId: "turn", ...payload }, images: [] },
} as NativeEvent);

describe("native thread transcript routing", () => {
  it("isolates a streaming child from concurrent parent tools and messages with reused item IDs", () => {
    const model = new SessionTranscript("root", "codex");
    const changed = vi.fn(); model.root.subscribe(changed);
    model.applyEvents([
      event(1, "child", "item/started", { item: { id: "same", type: "agentMessage", text: "" } }),
      event(2, "root", "item/started", { item: { id: "same", type: "commandExecution", command: "Parent tool", status: "inProgress" } }),
      event(3, "child", "item/agentMessage/delta", { itemId: "same", delta: "Child answer" }),
      event(4, "root", "item/completed", { item: { id: "answer", type: "agentMessage", text: "Parent answer" } }),
    ]);
    expect(model.root.count).toBe(2);
    expect(model.root.at(0)).toMatchObject({ kind: "tool", title: "Parent tool" });
    expect(model.root.at(1)?.body).toBe("Parent answer");
    expect(model.threads[0]?.store.at(0)?.body).toBe("Child answer");
    expect(changed).toHaveBeenCalledTimes(1);
    model.applyEvents([event(5, "child", "item/agentMessage/delta", { itemId: "same", delta: " continued" })]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(model.threads[0]?.store.at(0)?.body).toBe("Child answer continued");
  });

  it("discovers children from paginated native activity while never identifying the root as a child", () => {
    const model = new SessionTranscript("root", "codex");
    model.appendHistory(entriesFromHistory({ harness: "codex", vendorSessionId: "root", payload: { images: [], json: { data: [
      { turnId: "turn", item: { id: "activity", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "/root/topology_audit" } },
      { turnId: "turn", item: { id: "self", type: "subAgentActivity", kind: "interacted", agentThreadId: "root", agentPath: "/root" } },
    ] } } } as never));
    expect(model.threads).toHaveLength(1);
    expect(model.threads[0]?.status).toBe("unknown");
    model.applyEvents([event(1, undefined, "thread/started", { thread: { id: "child", agentNickname: "Avicenna" } })]);
    expect(subagentLabel(model.threads[0]!)).toBe("Avicenna · topology_audit");
  });

  it("keeps child errors, lifecycle and prompts out of parent state", () => {
    const model = new SessionTranscript("root", "codex");
    model.root.addLocal({ id: "local", kind: "user", title: "You", body: "same prompt", raw: {} });
    model.applyEvents([
      event(1, "child", "item/started", { item: { id: "prompt", type: "userMessage", content: [{ type: "text", text: "same prompt" }] } }),
      event(2, "child", "error", { error: { message: "Capacity reached", codexErrorInfo: "serverOverloaded" }, willRetry: false }),
    ]);
    expect(model.root.count).toBe(1);
    expect(model.root.get("local")).toBeDefined();
    expect(model.threads[0]?.status).toBe("error");
    expect(model.threads[0]?.store.at(1)?.failure).toBeDefined();
    model.applyEvents([event(3, "child", "turn/started", { turn: { id: "next" } })]);
    expect(model.threads[0]?.status).toBe("running");
    model.applyEvents([event(4, "child", "turn/completed", { turn: { id: "next", status: "completed" } })]);
    expect(model.threads[0]?.status).toBe("idle");
    model.markGap();
    expect(model.threads[0]?.status).toBe("unknown");
    expect(model.hasGap).toBe(true);
  });

  it("rejects unfenced Codex items, old epochs and replayed lifecycle updates", () => {
    const model = new SessionTranscript("root", "codex");
    model.applyEvents([event(1, undefined, "item/agentMessage/delta", { itemId: "ambiguous", delta: "unknown" }),
      event(2, "child", "turn/completed", { turn: { status: "completed" } })]);
    model.applyEvents([event(1, "child", "turn/started"), { ...event(3, "other", "turn/started"), runtimeEpoch: "other-epoch" }]);
    expect(model.root.count).toBe(0);
    expect(model.threads).toHaveLength(1);
    expect(model.threads[0]?.status).toBe("idle");
  });
});


it("keeps fallback history IDs distinct across native pages and from real IDs", async () => {
  const model = new SessionTranscript("root", "codex");
  const query = vi.fn(async (input: { request: { cursor?: string } }) => ({
    harness: "codex", vendorSessionId: "root", complete: Boolean(input.request.cursor),
    ...(input.request.cursor ? {} : { nextCursor: "next" }),
    payload: { images: [], json: { data: [{ turnId: "turn", item: { type: "agentMessage", text: input.request.cursor ?? "first" } }] } },
  }));
  const pager = new NativeHistoryPager({ sessions: { readNativeHistory: { query } } } as never, { sessionId: "session", harness: "codex" } as never);
  const signal = new AbortController().signal;
  model.appendHistory((await pager.next(signal)).entries);
  model.appendHistory((await pager.next(signal)).entries);
  expect(model.root.count).toBe(2);
  expect(model.root.at(0)?.id).not.toBe(model.root.at(1)?.id);
  expect(model.root.at(0)?.id).toMatch(/^codex-history:/);
});
