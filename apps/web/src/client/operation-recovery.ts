import { payloadHash, type AccessClient } from "@arduano/agent-multiplex-client/browser";
import { commandEnvelopeSchema, launchRequestSchema, resolveInteractionInputSchema, resumeCommandSchema, stopCommandSchema, type CommandEnvelope, type LaunchRequest, type ResolveInteractionInput, type ResumeCommand, type StopCommand } from "@arduano/agent-multiplex-protocol";
import { currentDraftScope, settleCommandDraft } from "./session-drafts.js";
import { documents, readDocument, removeDocument, writeDocument } from "./draft-storage.js";

export type SavedOperation = { id: string; kind: "command" | "launch" | "resolve"; payload: CommandEnvelope | StopCommand | ResumeCommand | LaunchRequest | ResolveInteractionInput; updatedAt: number };
export async function saveOperation(kind: SavedOperation["kind"], payload: SavedOperation["payload"]): Promise<SavedOperation> {
  const id = "commandId" in payload ? payload.commandId : "launchId" in payload ? payload.launchId : payload.interactionId;
  const operation: SavedOperation = { id, kind, payload, updatedAt: Date.now() };
  const scope = currentDraftScope();
  const existing = await readDocument<SavedOperation>(scope, `operation:${id}`);
  if (existing) {
    if (existing.value.kind !== kind || (await payloadHash(existing.value.payload)) !== (await payloadHash(payload))) throw new Error("This operation ID already has a different saved request");
    return existing.value;
  }
  await writeDocument(scope, `operation:${id}`, "operation", operation, 0);
  return operation;
}
export async function listOperations(): Promise<SavedOperation[]> { return (await documents<SavedOperation>(currentDraftScope())).filter((entry) => entry.kind === "operation").map((entry) => entry.value); }
export async function forgetOperation(id: string): Promise<void> { await removeDocument(currentDraftScope(), `operation:${id}`); }
export async function settleOperation(operation: SavedOperation, receipt: { state: string } | null): Promise<void> {
  if (!operationFinished(receipt)) return;
  if (operation.kind === "command" && !("operation" in operation.payload)) await settleCommandDraft(commandEnvelopeSchema.parse(operation.payload), receipt!.state === "succeeded");
  await forgetOperation(operation.id);
}
export async function reconcileOperation(client: AccessClient, operation: SavedOperation) {
  if (operation.kind === "launch") {
    const input = launchRequestSchema.parse(operation.payload);
    const receipt = await client.launches.get.query(input.launchId);
    if (receipt && receipt.payloadHash !== input.payloadHash) throw new Error("The saved launch differs from the host receipt");
    return receipt;
  }
  if (operation.kind === "resolve") {
    const input = resolveInteractionInputSchema.parse(operation.payload);
    const receipt = (await client.interactions.list.query({ sessionId: input.sessionId, pendingOnly: false })).find((item) => item.interactionId === input.interactionId) ?? null;
    if (receipt?.state === "resolved" && (!receipt.resolution || receipt.resolution.images.length || (await payloadHash(receipt.resolution.json)) !== (await payloadHash(input.response)))) throw new Error("This interaction was resolved with a different answer");
    return receipt;
  }
  const input = commandInput(operation);
  const receipt = await client.commands.get.query(input.commandId);
  if (receipt && receipt.payloadHash !== input.payloadHash) throw new Error("The saved command differs from the host receipt");
  return receipt;
}
export async function dispatchSavedOperation(client: AccessClient, operation: SavedOperation) {
  if (operation.kind === "launch") return client.launches.create.mutate(launchRequestSchema.parse(operation.payload));
  if (operation.kind === "resolve") return client.interactions.resolve.mutate(resolveInteractionInputSchema.parse(operation.payload));
  const input = commandInput(operation);
  if ("operation" in input) return input.operation === "stop" ? client.sessions.stop.mutate(input) : client.sessions.resume.mutate(input);
  return client.sessions.execute.mutate(input);
}
export function operationFinished(receipt: { state: string } | null): boolean { return receipt !== null && ["succeeded", "resolved", "failed", "stale", "expired"].includes(receipt.state); }
function commandInput(operation: SavedOperation) {
  const kind = (operation.payload as { operation?: string }).operation;
  return kind === "stop" ? stopCommandSchema.parse(operation.payload) : kind === "resume" ? resumeCommandSchema.parse(operation.payload) : commandEnvelopeSchema.parse(operation.payload);
}
