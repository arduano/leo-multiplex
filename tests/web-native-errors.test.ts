import { describe, expect, it, vi } from "vitest";
import type { NativeEvent, NativeHistoryResult } from "@arduano/agent-multiplex-protocol";
import { codexFailure, failureFromEvent, type NativeFailure } from "../apps/web/src/client/native-errors.js";
import { entriesFromHistory, projectNativeEvent } from "../apps/web/src/client/transcript.js";
import { TranscriptStore } from "../apps/web/src/client/transcript-store.js";

const context = { id: "failure", threadId: "root-thread", turnId: "turn-1" };
const capacityError = {
  message: "The service is overloaded. Please try again later.",
  codexErrorInfo: "serverOverloaded",
  additionalDetails: "Native diagnostic detail\nwith its original line break.",
};

function nativeEvent(sequence: number, nativeType: string, json: unknown, harness: "codex" | "copilot" = "codex"): NativeEvent {
  return {
    kind: "native", harness, runtimeEpoch: "epoch", sequence, nativeType,
    payload: { encoding: "native-json-images-v1", json, images: [] },
  } as NativeEvent;
}

function codexError(sequence = 1, threadId = "root-thread", turnId = "turn-1", willRetry = true): NativeEvent {
  return nativeEvent(sequence, "error", { threadId, turnId, willRetry, error: capacityError });
}

function failedCompletion(sequence = 2, threadId = "root-thread", turnId = "turn-1", error: unknown = capacityError): NativeEvent {
  return nativeEvent(sequence, "turn/completed", { threadId, turn: { id: turnId, status: "failed", items: [], error } });
}

function history(harness: "codex" | "copilot", json: unknown): NativeHistoryResult {
  return {
    harness, vendorSessionId: "root-thread", complete: true,
    payload: { encoding: "native-json-images-v1", json, images: [] },
  } as NativeHistoryResult;
}

describe("native failure normalization", () => {
  const classifications = [
    ["serverOverloaded", "Model at capacity"],
    ["usageLimitExceeded", "Usage limit reached"],
    ["rateLimitExceeded", "Rate limit reached"],
    ["sessionBudgetExceeded", "Session budget reached"],
    ["contextWindowExceeded", "Context limit reached"],
    ["unauthorized", "Authentication or access failed"],
  ] as const;

  it.each(classifications)("uses native %s classification without rewriting the message", (code, title) => {
    const message = "  Exact native message.\nSecond line.  ";
    const failure: NativeFailure = codexFailure({ message, codexErrorInfo: code }, context);
    expect(failure).toMatchObject({ ...context, code, title, message, willRetry: false });
    expect(failure.guidance.trim()).not.toBe("");
  });

  it("gives capacity, usage, rate, budget, context, and authentication distinct guidance", () => {
    const guidance = classifications.map(([codexErrorInfo]) => codexFailure({ message: "Native error", codexErrorInfo }, context).guidance);
    expect(new Set(guidance).size).toBe(classifications.length);
  });

  it("prefers the native code when message wording suggests another kind of limit", () => {
    expect(codexFailure({ message: "The service is overloaded; rate limit exceeded.", codexErrorInfo: "usageLimitExceeded" }, context))
      .toMatchObject({ title: "Usage limit reached", code: "usageLimitExceeded" });
    expect(codexFailure({ message: "You have hit your usage limit.", codexErrorInfo: "unauthorized" }, context))
      .toMatchObject({ title: "Authentication or access failed", code: "unauthorized" });
  });

  it("recognizes explicit overload wording behind an uncategorized native error", () => {
    for (const codexErrorInfo of ["other", { responseStreamConnectionFailed: { httpStatusCode: 503 } }]) {
      expect(codexFailure({ message: "The model is at capacity.", codexErrorInfo }, context).title).toBe("Model at capacity");
    }
  });

  it.each([
    ["The service is overloaded. Please try again later.", "Model at capacity"],
    ["You have hit your usage limit.", "Usage limit reached"],
    ["Rate limit exceeded. Please wait before sending another request.", "Rate limit reached"],
    ["Session budget exceeded.", "Session budget reached"],
    ["Context window exceeded.", "Context limit reached"],
  ])("can classify explicit error.message wording: %s", (message, title) => {
    expect(codexFailure({ message, codexErrorInfo: null }, context)).toMatchObject({ title, message });
  });

  it("does not infer a classification from additional details or claim an unknown failure will retry", () => {
    const failure = codexFailure({
      message: "An unfamiliar native failure occurred.",
      additionalDetails: "server overloaded; usage limit exceeded; authentication required",
    }, context);
    expect(failure).toMatchObject({ title: "Codex error", message: "An unfamiliar native failure occurred.", willRetry: false });
    expect(codexFailure({ message: "Unfamiliar failure" }, { ...context, willRetry: true }).willRetry).toBe(true);
  });

  it("uses structured native HTTP errors before contrary message text", () => {
    expect(codexFailure({ message: "The model is overloaded.", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, context))
      .toMatchObject({ title: "Authentication or access failed", code: "httpConnectionFailed" });
    expect(codexFailure({ message: "Unknown error", codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } } }, context))
      .toMatchObject({ title: "Rate limit reached", code: "responseStreamConnectionFailed" });
    expect(codexFailure({ message: "The model is overloaded.", codexErrorInfo: "unrecognizedError" }, context).title).toBe("Codex error");
  });

  it("retains plain native details and ignores non-string diagnostic structures", () => {
    expect(codexFailure(capacityError, context).details).toBe(capacityError.additionalDetails);
    for (const additionalDetails of [{ privateField: "do not serialize" }, ["do not serialize"], 42, null]) {
      const failure = codexFailure({ message: "Native error", additionalDetails }, context);
      expect(failure.details).toBeUndefined();
      expect(failure.message).toBe("Native error");
    }
  });

  it("bounds display fields to 16 KiB even for multibyte native text", () => {
    const message = "🙂".repeat(20_000);
    const additionalDetails = "界".repeat(20_000);
    const failure = codexFailure({ message, additionalDetails }, context);
    for (const value of Object.values(failure)) {
      if (typeof value === "string") expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(16 * 1_024);
    }
    expect(failure.message).not.toBe("");
    expect(failure.details).not.toBe("");
    expect(failure.message).not.toBe(message);
    expect(failure.details).not.toBe(additionalDetails);
  });
});

describe("native error events", () => {
  it("keeps native retry state until the same turn completes as failed", () => {
    const announced = failureFromEvent(codexError());
    const completed = failureFromEvent(failedCompletion());
    expect(announced).toMatchObject({ title: "Model at capacity", message: capacityError.message, willRetry: true, threadId: "root-thread", turnId: "turn-1" });
    expect(completed).toMatchObject({ title: "Model at capacity", message: capacityError.message, willRetry: false });
    expect(completed?.id).toBe(announced?.id);
  });

  it("exposes a failed completion even when Codex omitted its error object", () => {
    const failed = failureFromEvent(failedCompletion(1, "root-thread", "turn-1", null));
    expect(failed).toMatchObject({ title: "Codex error", willRetry: false, turnId: "turn-1" });
    expect(failed?.message.trim()).toBeTruthy();
    expect(failureFromEvent(nativeEvent(2, "turn/completed", { threadId: "root-thread", turn: { id: "turn-2", status: "completed", error: null } }))).toBeNull();
  });

  it("continues to recognize legacy turn/failed events", () => {
    const failed = failureFromEvent(nativeEvent(1, "turn/failed", { threadId: "root-thread", turnId: "turn-1", error: capacityError }));
    expect(failed).toMatchObject({ title: "Model at capacity", message: capacityError.message, willRetry: false });
  });

  it("distinguishes subagent threads and separate turns while deduplicating each turn", () => {
    const root = failureFromEvent(codexError(1, "root-thread", "turn-1"));
    const child = failureFromEvent(codexError(2, "child-thread", "turn-1"));
    const nextTurn = failureFromEvent(codexError(3, "root-thread", "turn-2"));
    expect(new Set([root?.id, child?.id, nextTurn?.id]).size).toBe(3);
    expect(failureFromEvent(failedCompletion(4, "child-thread", "turn-1"))?.id).toBe(child?.id);
  });

  it("normalizes Copilot session.error without dumping its native record", () => {
    const raw = { id: "copilot-error", type: "session.error", data: { errorType: "query", message: "Exact Copilot failure", metadata: { diagnostic: "not display text" } } };
    const failed = failureFromEvent(nativeEvent(1, "session.error", raw, "copilot"));
    expect(failed).toMatchObject({ title: "Copilot error", message: raw.data.message, willRetry: false });
    const projected = projectNativeEvent(nativeEvent(1, "session.error", raw, "copilot"), () => undefined);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ kind: "notice", title: "Copilot error", body: raw.data.message, pending: false, failure: { id: failed?.id } });
    const retained = entriesFromHistory(history("copilot", [raw]));
    expect(retained[0]?.failure?.id).toBe(failed?.id);
  });

  it.each([
    nativeEvent(1, "item/completed", { item: { id: "assistant", type: "agentMessage", text: "The server is overloaded and your usage limit was exceeded." } }),
    nativeEvent(2, "item/completed", { item: { id: "tool", type: "commandExecution", command: "example", aggregatedOutput: "Authentication required; context window exceeded.", status: "completed" } }),
    nativeEvent(3, "assistant.message", { id: "assistant", type: "assistant.message", data: { messageId: "assistant", content: "Rate limit exceeded. Session budget exceeded." } }, "copilot"),
    nativeEvent(4, "tool.execution_complete", { id: "tool", type: "tool.execution_complete", data: { toolCallId: "tool", success: false, result: { content: "The service is overloaded." } } }, "copilot"),
  ])("leaves ordinary assistant/tool text alone ($harness $nativeType)", (event) => {
    expect(failureFromEvent(event)).toBeNull();
    const entries = projectNativeEvent(event, () => undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.failure).toBeUndefined();
  });
});

describe("native failure transcript integration", () => {
  it("updates one stable failure row when an error is followed by failed completion", () => {
    const store = new TranscriptStore();
    store.applyEvents([codexError()]);
    const first = store.at(0)!;
    expect(first).toMatchObject({ kind: "notice", title: "Model at capacity", body: capacityError.message, pending: false, failure: { willRetry: true } });
    const lookup = vi.fn((id: string) => store.get(id));
    const changed = projectNativeEvent(failedCompletion(), lookup);
    expect(changed).toHaveLength(1);
    expect(lookup).toHaveBeenCalledWith(first.id);
    expect(changed[0]?.id).toBe(first.id);
    store.applyEvents([failedCompletion()]);
    expect(store.count).toBe(1);
    expect(store.at(0)?.failure?.willRetry).toBe(false);
  });

  it("retains useful error details when final failure has no replacement error", () => {
    const store = new TranscriptStore();
    store.applyEvents([codexError(), failedCompletion(2, "root-thread", "turn-1", null)]);
    expect(store.count).toBe(1);
    expect(store.at(0)).toMatchObject({ title: "Model at capacity", body: capacityError.message, failure: { details: capacityError.additionalDetails, willRetry: false } });
  });

  it("retains structured HTTP classification when repeated final failures omit the error", () => {
    const store = new TranscriptStore();
    store.applyEvents([
      nativeEvent(1, "error", { threadId: "root-thread", turnId: "turn-1", willRetry: true,
        error: { message: "Native provider failure", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } } }),
      failedCompletion(2, "root-thread", "turn-1", null),
      failedCompletion(3, "root-thread", "turn-1", null),
    ]);
    expect(store.count).toBe(1);
    expect(store.at(0)?.failure).toMatchObject({ title: "Rate limit reached", willRetry: false });
    expect(store.at(0)?.failure?.guidance).not.toContain("retrying automatically");
  });

  it("keeps root and child failures separate in the indexed transcript", () => {
    const store = new TranscriptStore();
    store.applyEvents([
      codexError(1, "root-thread"), codexError(2, "child-thread"),
      failedCompletion(3, "root-thread"), failedCompletion(4, "child-thread"),
    ]);
    expect(store.count).toBe(2);
    expect(store.at(0)?.id).not.toBe(store.at(1)?.id);
    expect([store.at(0)?.failure?.willRetry, store.at(1)?.failure?.willRetry]).toEqual([false, false]);
  });

  it("restores failed turn errors after their native items and merges a matching live failure", () => {
    const result = history("codex", { thread: { id: "root-thread", turns: [
      { id: "turn-1", status: "failed", startedAt: 1_700_000_000, items: [{ id: "answer", type: "agentMessage", text: "Partial answer", phase: "final_answer" }], error: capacityError },
      { id: "turn-2", status: "failed", items: [], error: null },
      { id: "turn-3", status: "completed", items: [{ id: "ordinary", type: "agentMessage", text: "Usage limit exceeded is an example message.", phase: "final_answer" }], error: null },
    ] } });
    const rows = entriesFromHistory(result);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ kind: "assistant", body: "Partial answer" });
    expect(rows[1]).toMatchObject({ kind: "notice", title: "Model at capacity", body: capacityError.message, pending: false, threadId: "root-thread", turnId: "turn-1" });
    expect(rows[2]?.failure).toMatchObject({ title: "Codex error", willRetry: false });
    expect(rows[3]?.failure).toBeUndefined();
    expect(rows[1]?.failure?.id).toBe(failureFromEvent(failedCompletion())?.id);
    const store = new TranscriptStore();
    store.applyEvents([codexError()]);
    store.appendHistory(rows);
    expect(store.count).toBe(rows.length);
    expect(store.at(1)?.failure?.willRetry).toBe(false);
  });

  it("keeps item-list history unchanged and does not infer errors from item text", () => {
    const rows = entriesFromHistory(history("codex", { data: [
      { turnId: "turn-1", item: { id: "answer", type: "agentMessage", text: "The service is overloaded.", phase: "final_answer" } },
    ], nextCursor: null }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "assistant", body: "The service is overloaded.", threadId: "root-thread", turnId: "turn-1", nativeItemId: "answer", historySnapshot: true });
    expect(rows[0]?.failure).toBeUndefined();
  });
});
