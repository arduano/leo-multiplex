import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_COMMAND_BYTES, workCommandSubmitSchema, type WorkCommandRecord } from "../../../packages/work-commands/src/contract.js";
import { matchingWorkCommand, WorkCommandHttpError } from "../../../packages/work-commands/src/http-client.js";
import type { Context } from "./dispatch.js";
import { inputFile, integer, option, required, type Arguments } from "./input.js";
import type { SavedOperation } from "./ledger.js";
import { CliError } from "./output.js";

export async function workCommand(args: Arguments, ctx: Context) {
  const port = commands(ctx);
  if (args.command === "exec-hosts") return port.hosts();
  if (args.command !== "exec") {
    const operation = await ctx.ledger.get(ctx.origin, args.positionals[0]!);
    if (!operation) throw new CliError("UNKNOWN_REQUEST", "No saved request has this ID for this gateway");
    return savedWorkCommand(ctx, operation, args.command === "exec-cancel" ? "cancel" : args.options.retry ? "retry" : "get");
  }
  const requestId = required(args, "request-id"), hostRef = required(args, "host"), cwd = required(args, "cwd");
  if (!posix.isAbsolute(cwd) && !win32.isAbsolute(cwd)) throw new CliError("USAGE", "--cwd must be an absolute path on the work host");
  const text = option(args, "text"), filename = option(args, "text-file");
  if ((text === undefined) === (filename === undefined)) throw new CliError("USAGE", "Provide exactly one of --text or --text-file");
  const command = filename !== undefined ? (await inputFile(filename, ctx.signal, MAX_COMMAND_BYTES)).toString("utf8") : text!;
  if (!command.trim() || Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new CliError("USAGE", "Provide a nonempty command of at most 16 KiB");
  const timeoutMs = integer(option(args, "run-timeout"), 30, 300) * 1000;
  const prepared = await ctx.ledger.prepare(ctx.origin, requestId, { command: "work-command", hostRef, cwd, text: command, timeoutMs }, async () => {
    const hosts = await port.hosts();
    const exact = hosts.find(host => host.sourceId === hostRef);
    const matches = exact ? [exact] : hosts.filter(host => host.name === hostRef);
    if (matches.length !== 1) throw new CliError("WORK_HOST_NOT_FOUND", "Choose an exact source ID or unique name from exec-hosts");
    const host = matches[0]!;
    if (!host.available) throw new CliError("WORK_HOST_OFFLINE", "The work host is offline. Reconnect before starting a command.", 4);
    return { kind: "work-command", payload: workCommandSubmitSchema.parse({ target: { sourceId: host.sourceId, endpointId: host.endpointId }, request: { operationId: randomUUID(), cwd, command, timeoutMs } }) };
  });
  return savedWorkCommand(ctx, prepared.operation, prepared.created ? "submit" : "get", true);
}

export async function savedWorkCommand(ctx: Context, operation: SavedOperation, action: "get" | "submit" | "retry" | "cancel", wait = false) {
  if (operation.kind !== "work-command") throw new CliError("REQUEST_KIND", "This request belongs to an agent operation. Use operation REQUEST_ID.");
  const port = commands(ctx), input = workCommandSubmitSchema.parse(operation.payload);
  const lookup = { target: input.target, operationId: input.request.operationId };
  const identity = { requestId: operation.requestId, kind: operation.kind, ...lookup };
  let receipt: WorkCommandRecord | null = null;
  try {
    ctx.signal.throwIfAborted();
    receipt = action === "submit" ? await port.submit(input) : action === "cancel" ? await port.cancel(lookup) : await port.get(lookup);
    // A retry is explicit and preserves the complete persisted envelope. A host
    // receipt, including outcomeUnknown, is never a reason to spawn again.
    if (!receipt && action === "retry") { ctx.signal.throwIfAborted(); receipt = await port.submit(input); }
    if (receipt) matchingWorkCommand(input.request, receipt);
    while (wait && receipt?.state === "running") {
      await delay(400, undefined, { signal: ctx.signal });
      receipt = await port.get(lookup);
      if (receipt) matchingWorkCommand(input.request, receipt);
    }
  } catch (error) {
    const data = { ...identity, receipt };
    if (ctx.signal.aborted) throw new CliError("WAIT_INTERRUPTED", "Local waiting stopped; the remote command was not cancelled. Use exec-status with this request ID.", 6, data);
    if (error instanceof WorkCommandHttpError && !["UNAVAILABLE", "OUTCOME_UNKNOWN", "INVALID_RESPONSE"].includes(error.code)) throw new CliError(error.code, error.message, ["FORBIDDEN", "UNAUTHORIZED"].includes(error.code) ? 3 : 4, data);
    throw new CliError("OUTCOME_UNKNOWN", "No reliable reply. Check exec-status with this request ID; the original command may still be running.", 5, data);
  }
  const data = { ...identity, receipt };
  if (!receipt || receipt.state === "outcomeUnknown") throw new CliError("OUTCOME_UNKNOWN", "The command outcome is unknown. Check the host before deciding on an explicit retry or local recovery.", 5, data);
  if (receipt.state === "timedOut" || receipt.state === "cancelled") throw new CliError("COMMAND_STOPPED", `The command ${receipt.state === "timedOut" ? "timed out" : "was cancelled"}.`, 6, data);
  if (receipt.state === "failed" || receipt.state === "completed" && receipt.exitCode !== 0) throw new CliError("COMMAND_FAILED", "The remote command failed. Review its exit status and output.", 7, data);
  return data;
}

function commands(ctx: Context) { if (!ctx.workCommands) throw new CliError("UNAVAILABLE", "Work command support is unavailable", 4); return ctx.workCommands; }
