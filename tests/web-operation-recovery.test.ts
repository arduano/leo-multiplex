import { describe, expect, it, vi } from "vitest";
import { sessionCommand, payloadHash } from "@arduano/agent-multiplex-client/browser";
import { reconcileOperation, operationFinished } from "../apps/web/src/client/operation-recovery.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe("durable mutation recovery", () => {
  it("only reads the original command receipt and rejects a conflicting payload", async () => {
    const command = await sessionCommand({ sessionId: id(1), runtimeNodeId: id(2), bindingRevision: 3 } as never, { harness: "codex", command: { type: "send", input: "Saved original" } });
    const query = vi.fn(async () => ({ commandId: command.commandId, payloadHash: command.payloadHash, state: "succeeded" }));
    const mutate = vi.fn();
    const client = { commands: { get: { query } }, sessions: { execute: { mutate } } };
    const operation = { id: command.commandId, kind: "command" as const, payload: command, updatedAt: 1 };
    expect((await reconcileOperation(client as never, operation))?.state).toBe("succeeded");
    expect(query).toHaveBeenCalledWith(command.commandId);
    expect(mutate).not.toHaveBeenCalled();
    query.mockResolvedValue({ commandId: command.commandId, payloadHash: "different", state: "succeeded" });
    await expect(reconcileOperation(client as never, operation)).rejects.toThrow("differs");
  });
  it("does not mistake another answer for successful reconciliation", async () => {
    const payload = { interactionId: id(1), sessionId: id(2), harness: "codex" as const, response: { answers: { q: { answers: ["A"] } } } };
    const operation = { id: payload.interactionId, kind: "resolve" as const, payload, updatedAt: 1 };
    const query = vi.fn(async () => [{ interactionId: id(1), state: "resolved", resolution: { json: { answers: { q: { answers: ["B"] } } }, images: [] } }]);
    await expect(reconcileOperation({ interactions: { list: { query } } } as never, operation as never)).rejects.toThrow("different answer");
    query.mockResolvedValue([{ interactionId: id(1), state: "resolved", resolution: { json: payload.response, images: [] } }]);
    expect((await reconcileOperation({ interactions: { list: { query } } } as never, operation as never))?.state).toBe("resolved");
    expect(await payloadHash(payload.response)).not.toBe(await payloadHash({ answers: { q: { answers: ["B"] } } }));
  });
  it("retains received, started and ambiguous work until a final receipt", () => {
    for (const state of ["received", "started", "outcomeUnknown", "pending", "preparing"]) expect(operationFinished({ state })).toBe(false);
    expect(operationFinished(null)).toBe(false);
    for (const state of ["succeeded", "resolved", "failed", "expired", "stale"]) expect(operationFinished({ state })).toBe(true);
  });
});
