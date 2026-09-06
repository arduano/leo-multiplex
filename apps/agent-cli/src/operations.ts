import { payloadHash, type AccessClient } from "@arduano/agent-multiplex-client";
import { commandEnvelopeSchema, launchRequestSchema, resolveInteractionInputSchema, resumeCommandSchema, stopCommandSchema } from "@arduano/agent-multiplex-protocol";
import type { SavedOperation } from "./ledger.js";
import { CliError } from "./output.js";

export function operationIdentity(operation: SavedOperation) {
  const p = operation.payload as Record<string, unknown>;
  if (operation.kind === "work-command") return { requestId: operation.requestId, kind: operation.kind, operationId: (p.request as { operationId?: string } | undefined)?.operationId, target: p.target };
  return { requestId: operation.requestId, kind: operation.kind, operationId: p.commandId ?? p.launchId ?? p.interactionId, sessionId: p.sessionId };
}
export async function reconcile(client: AccessClient, operation: SavedOperation) {
  const p = operation.payload;
  if (operation.kind === "launch") {
    const input = launchRequestSchema.parse(p);
    const record = await client.launches.get.query(input.launchId);
    if (record && record.payloadHash !== input.payloadHash) throw new CliError("OPERATION_CONFLICT", "The remote launch differs from the saved request", 4);
    return record;
  }
  if (operation.kind === "resolve") {
    const input = resolveInteractionInputSchema.parse(p);
    const record = (await client.interactions.list.query({ sessionId: input.sessionId, pendingOnly: false })).find(r => r.interactionId === input.interactionId) ?? null;
    if (record?.state === "resolved" && (!record.resolution || record.resolution.images.length || payloadHash(record.resolution.json) !== payloadHash(input.response))) {
      throw new CliError("RESOLUTION_CONFLICT", "The interaction was resolved with a different response", 4, operationIdentity(operation));
    }
    return record;
  }
  const input = commandInput(operation);
  const record = await client.commands.get.query(input.commandId);
  if (record && record.payloadHash !== input.payloadHash) throw new CliError("OPERATION_CONFLICT", "The remote command differs from the saved request", 4);
  return record;
}
export async function dispatchSaved(client: AccessClient, operation: SavedOperation) {
  const launch = operation.kind === "launch" ? launchRequestSchema.parse(operation.payload) : undefined;
  const resolution = operation.kind === "resolve" ? resolveInteractionInputSchema.parse(operation.payload) : undefined;
  const p = operation.kind === "command" ? commandInput(operation) : undefined;
  try {
    if (launch) return await client.launches.create.mutate(launch);
    if (resolution) return await client.interactions.resolve.mutate(resolution);
    if (!p) throw new Error("Invalid saved operation");
    if ("operation" in p) return p.operation === "stop" ? await client.sessions.stop.mutate(p) : await client.sessions.resume.mutate(p);
    return await client.sessions.execute.mutate(p);
  } catch {
    // Even a timeout or dropped HTTP reply can follow a committed side effect.
    // The private saved envelope is the only retry source, never a new command ID.
    throw new CliError("OUTCOME_UNKNOWN", "The mutation did not return a receipt. Check operation with this request ID before deciding to retry.", 5, operationIdentity(operation));
  }
}
export function commandInput(operation: SavedOperation) {
  if (operation.kind !== "command") throw new CliError("REQUEST_KIND", "Use the matching operation handler for this saved request");
  const type = (operation.payload as { operation?: string }).operation;
  return type === "stop" ? stopCommandSchema.parse(operation.payload) : type === "resume" ? resumeCommandSchema.parse(operation.payload) : commandEnvelopeSchema.parse(operation.payload);
}
export function checkedReceipt(operation: SavedOperation, record: Awaited<ReturnType<typeof reconcile>>) {
  const data = { ...operationIdentity(operation), receipt: record, ...(operation.kind === "command" ? { acknowledgmentOnly: true } : {}) };
  if (!record) throw new CliError("OUTCOME_UNKNOWN", "No remote receipt was found. Use operation REQUEST_ID --retry only after reviewing this uncertainty.", 5, data);
  if (record.state === "failed" || record.state === "stale" || record.state === "expired") throw new CliError("OPERATION_FAILED", "The remote operation failed or is no longer actionable", 4, data);
  if (!["succeeded", "resolved"].includes(record.state)) throw new CliError("OUTCOME_UNKNOWN", "The operation is pending or its outcome is unknown. Reconcile the same request ID.", 5, data);
  return data;
}
