import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { imageMessage, launchRequest, resumeCommand, sessionCommand, stopCommand, type AccessClient, type AccessWatchCursor } from "@arduano/agent-multiplex-client";
import { accessAttachInputSchema, commandEnvelopeSchema, harnessCommandSchema, harnessSchema, interactionIdSchema, jsonValueSchema, launchProfileIdentitySchema, launchRequestSchema, sessionIdSchema, sessionSearchInputSchema, type Harness, type RuntimeNodeDescriptor, type SessionRecord } from "@arduano/agent-multiplex-protocol";
import { inputFile, integer, jsonFile, option, required, commandOptions, type Arguments } from "./input.js";
import { OperationLedger, type SavedOperation } from "./ledger.js";
import { observeTurn, streamEvents, type TurnOutcome } from "./observe.js";
import { checkedReceipt, dispatchSaved, operationIdentity, reconcile } from "./operations.js";
import { CliError, result } from "./output.js";
import { imageCommand, loadImageDescriptors } from "./images.js";

export interface Context { client: AccessClient; origin: string; signal: AbortSignal; ledger: OperationLedger; write: (value: unknown) => Promise<void> }
export const help = {
  name: "leo-agents", version: 1, output: "JSON; watch emits NDJSON", commands: commandOptions,
  positionalArguments: { status: "SESSION_ID", history: "SESSION_ID", watch: "SESSION_ID", wait: "SESSION_ID", send: "SESSION_ID", steer: "SESSION_ID", interrupt: "SESSION_ID", stop: "SESSION_ID", resume: "SESSION_ID", command: "SESSION_ID", operation: "REQUEST_ID", questions: "SESSION_ID", resolve: "SESSION_ID INTERACTION_ID", "image-upload": "SESSION_ID", "image-get": "SESSION_ID" },
  globalOptions: { url: "Gateway origin; LEO_AGENTS_URL or the personal Tailscale gateway", timeout: "Seconds, default 30 (watch/wait/send --wait: 300), maximum 86400", "state-dir": "Private request ledger; LEO_AGENTS_STATE_DIR or XDG state/leo-agents" },
  rules: ["Mutation commands require a caller-owned --request-id (1–128 ASCII letters/digits/._-).", "Reusing a request ID reconciles the saved operation; it never silently sends again.", "operation REQUEST_ID --retry explicitly reuses the immutable saved request.", "Acknowledgment is not turn completion. send --wait observes the returned Codex turn ID.", "Capacity/native systemError blocks send until reviewed; --allow-error is an explicit override.", "history returns one native page of at most 100 items, oldest first; follow nextCursor.", "wait requires --turn-id. Without a replay cursor, only future events prove completion.", "watch cursor files are scoped to gateway, session and runtime binding. Gaps require reconciliation.", "Images: upload with caller-owned --image-id; save data as descriptor JSON; send with --image-json.", "No automatic resume, prompt retry, or question approval. See docs/Agent-CLI.md." ],
  exitCodes: { "0": "success", "2": "usage/local input", "3": "authentication", "4": "remote failure", "5": "outcome unknown or stream gap", "6": "timeout/cancelled", "7": "native failure, interrupted, or needs input" },
};
export async function dispatch(args: Arguments, ctx: Context): Promise<unknown> {
  const { client, signal } = ctx;
  const { command } = args;
  const count = command === "resolve" ? 2 : Object.hasOwn(help.positionalArguments, command) ? 1 : 0;
  if (args.positionals.length !== count) throw new CliError("USAGE", `${command} expects ${count} positional argument(s); run leo-agents help`);
  if (command === "help") return help;
  if (command === "id") return { requestId: randomUUID() };
  if (command === "hosts") {
    const hosts = await client.runtimeNodes.list.query();
    return args.options.raw ? hosts : hosts.map(({ runtimeNodeId, name, presence, reachability, harnesses }) => ({ runtimeNodeId, name, presence, reachability, harnesses: harnesses.map(h => h.harness) }));
  }
  if (command === "sessions") {
    const page = await client.sessions.search.query(sessionSearchInputSchema.parse({ limit: integer(option(args, "limit"), 100, 500), ...(option(args, "cursor") ? { cursor: option(args, "cursor") } : {}), ...(args.options["all-states"] ? { states: ["running", "stopped", "archived"] } : {}) }));
    return { sessions: args.options.raw ? page.sessions : page.sessions.map(sessionSummary), nextCursor: page.nextCursor };
  }
  if (command === "profiles" || command === "models") {
    const host = await selectHost(client, required(args, "host"));
    const harness = harnessSchema.parse(option(args, "harness") ?? "codex");
    if (command === "profiles") return client.launchProfiles.list.query({ runtimeNodeId: host.runtimeNodeId, harness });
    return client.launchProfiles.models.query({ runtimeNodeId: host.runtimeNodeId, harness, profile: await selectProfile(client, host, harness) });
  }
  if (command === "operation") {
    const operation = await ctx.ledger.get(ctx.origin, args.positionals[0]!);
    if (!operation) throw new CliError("UNKNOWN_REQUEST", "No locally saved operation has this request ID for this gateway");
    const record = await reconcile(client, operation);
    const complete = record && ["succeeded", "resolved", "failed", "stale", "expired"].includes(record.state);
    return checkedReceipt(operation, args.options.retry && !complete ? await dispatchSaved(client, operation) : record);
  }
  if (command === "launch") {
    const requestId = required(args, "request-id");
    const cwd = required(args, "cwd"); const hostRef = required(args, "host");
    if (!isAbsolute(cwd)) throw new CliError("USAGE", "--cwd must be an absolute path on the selected host");
    const harness = harnessSchema.parse(option(args, "harness") ?? "codex");
    const mode = option(args, "mode");
    if (mode && !["default", "plan"].includes(mode)) throw new CliError("USAGE", "--mode must be default or plan");
    const input = { cwd, ...(option(args, "model") ? { model: option(args, "model")! } : {}), ...(option(args, "effort") ? { [harness === "codex" ? "effort" : "reasoningEffort"]: option(args, "effort")! } : {}), ...(mode ? { mode: harness === "copilot" && mode === "default" ? "interactive" : mode } : {}) };
    const title = option(args, "title");
    const prepared = await ctx.ledger.prepare(ctx.origin, requestId, { command, hostRef, harness, input, title }, async () => {
      const host = await selectHost(client, hostRef);
      return { kind: "launch", payload: launchRequestSchema.parse(launchRequest(host.runtimeNodeId, await selectProfile(client, host, harness), harness, input, title ? { "agent.title": title } : undefined)) };
    });
    signal.throwIfAborted();
    return checkedReceipt(prepared.operation, prepared.created ? await dispatchSaved(client, prepared.operation) : await reconcile(client, prepared.operation));
  }
  const sessionId = sessionIdSchema.parse(args.positionals[0]);
  // Repeated operations must still reconcile if the host/binding has changed.
  if (["send", "steer", "interrupt", "stop", "resume", "command", "resolve"].includes(command)) return mutate(args, ctx, sessionId);
  const session = await getSession(client, sessionId);
  if (command === "status") return { session: args.options.raw ? session : sessionSummary(session), ...(session.harness === "codex" && session.availability === "active" ? { native: await nativeStatus(client, session) } : {}) };
  if (command === "questions") return client.interactions.list.query({ sessionId, pendingOnly: true });
  if (command === "history") return client.sessions.readNativeHistory.query({ sessionId, request: { harness: session.harness, ...(session.harness === "codex" ? { includeTurns: true } : {}), limit: integer(option(args, "limit"), 100, 100), ...(option(args, "cursor") ? { cursor: option(args, "cursor")! } : {}) } });
  if (command === "image-upload" || command === "image-get") return imageCommand(args, client, session, await selectHost(client, session.runtimeNodeId), signal);
  if (command === "watch" || command === "wait") {
    const filename = option(args, "cursor-file");
    const cursor = filename ? await readCursor(filename, ctx, session) : undefined;
    if (command === "watch") return streamEvents(client, session, { signal, cursor, maximum: integer(option(args, "max-events"), 1000, 1_000_000), async write(item, next) { await ctx.write(result("watch", { item, cursor: next })); if (filename && next && item.kind !== "streamReset" && item.kind !== "nativeGap") await saveCursor(filename, ctx, session, next); } });
    codexOnly(session);
    const turnId = required(args, "turn-id");
    const observer = observeTurn(client, session, { signal, cursor });
    try { const outcome = await observer.wait(turnId); if (filename && outcome.cursor) await saveCursor(filename, ctx, session, outcome.cursor); return checkedOutcome(outcome); }
    finally { observer.close(); }
  }
  throw new CliError("USAGE", "Unsupported command");
}

async function mutate(args: Arguments, ctx: Context, sessionId: SessionRecord["sessionId"]) {
  const { client, signal, ledger, origin } = ctx;
  const requestId = required(args, "request-id");
  const command = args.command;
  let body: unknown;
  if (command === "send" || command === "steer") {
    const text = option(args, "text"); const file = option(args, "text-file");
    if (text !== undefined && file !== undefined) throw new CliError("USAGE", "Use one of --text and --text-file");
    if (file === "-" && (args.options["image-json"] as string[] | undefined)?.includes("-")) throw new CliError("USAGE", "stdin can supply only one input");
    const input = file ? (await inputFile(file, signal)).toString("utf8") : text ?? "";
    const images = await loadImageDescriptors(args, signal);
    if ((!input.trim() && !images.length) || Buffer.byteLength(input) > 1_048_576) throw new CliError("USAGE", "Provide a nonempty message or image, within the 1 MiB input bound");
    body = { text: input, images, turnId: option(args, "turn-id") };
  } else if (command === "command") body = harnessCommandSchema.parse(await jsonFile(required(args, "command-file"), signal));
  else if (command === "resolve") body = { interactionId: interactionIdSchema.parse(args.positionals[1]), response: jsonValueSchema.parse(await jsonFile(required(args, "response-file"), signal)) };
  else body = { turnId: option(args, "turn-id") };
  const prepared = await ledger.prepare(origin, requestId, { command, sessionId, body }, async () => {
    const session = await getSession(client, sessionId);
    await selectHost(client, session.runtimeNodeId);
    if (command === "stop" || command === "resume") return { kind: "command", payload: command === "stop" ? stopCommand(session) : resumeCommand(session) };
    if (command === "resolve") return { kind: "resolve", payload: { ...body as object, sessionId, harness: session.harness } };
    if (session.availability !== "active" || session.catalogState !== "open") throw new CliError("SESSION_INACTIVE", "The session must be active and open. Review status before explicitly resuming it.", 7);
    if (command === "command") {
      const request = harnessCommandSchema.parse(body);
      if (request.harness !== session.harness) throw new CliError("HARNESS_MISMATCH", "Command harness must match the session");
      if (request.command.type === "send") await sendPreflight(ctx, session, args.options["allow-error"] === true);
      return { kind: "command", payload: commandEnvelopeSchema.parse(sessionCommand(session, request)) };
    }
    if (command === "interrupt") {
      if (option(args, "turn-id") && session.harness !== "codex") throw new CliError("USAGE", "--turn-id requires Codex");
      return { kind: "command", payload: sessionCommand(session, harnessCommandSchema.parse({ harness: session.harness, command: { type: "interrupt", ...(option(args, "turn-id") ? { turnId: option(args, "turn-id") } : {}) } })) };
    }
    if (args.options.wait) codexOnly(session);
    if (command === "send") await sendPreflight(ctx, session, args.options["allow-error"] === true);
    const messageBody = body as { text: string; images: Parameters<typeof imageMessage>[3]; turnId?: string };
    if (messageBody.turnId && session.harness !== "codex") throw new CliError("USAGE", "--turn-id requires Codex");
    const message = imageMessage(session.harness, command as "send" | "steer", messageBody.text, messageBody.images);
    const request = messageBody.turnId ? harnessCommandSchema.parse({ ...message.request, command: { ...message.request.command, expectedTurnId: messageBody.turnId } }) : message.request;
    return { kind: "command", payload: commandEnvelopeSchema.parse(sessionCommand(session, request, message.images)) };
  });
  const operation = prepared.operation;
  let observer: ReturnType<typeof observeTurn> | undefined;
  try {
    if (args.options.wait && prepared.created) {
      const session = await getSession(client, sessionId); codexOnly(session);
      const payload = operation.payload as { bindingRevision: number };
      if (session.bindingRevision !== payload.bindingRevision) throw new CliError("BINDING_CHANGED", "The session binding changed before dispatch", 5, operationIdentity(operation));
      observer = observeTurn(client, session, { signal }); await observer.ready;
    }
    signal.throwIfAborted();
    const record = prepared.created ? await dispatchSaved(client, operation) : await reconcile(client, operation);
    const receipt = checkedReceipt(operation, record);
    const turnId = nativeTurnId(record);
    if (args.options.wait) {
      if (!prepared.created || !observer || !turnId) throw new CliError("TURN_OUTCOME_UNKNOWN", "The command was acknowledged, but no complete observation is available. Inspect history or wait with a retained cursor; do not resend.", 5, { ...receipt, turnId });
      const outcome = await observer.wait(turnId);
      return { ...receipt, acknowledgmentOnly: false, turnId, outcome: checkedOutcome(outcome, operation) };
    }
    return { ...receipt, ...(turnId ? { turnId } : {}) };
  } finally { observer?.close(); }
}
function nativeTurnId(record: unknown): string | undefined {
  const turn = (record as { result?: { json?: { turn?: { id?: unknown } } } } | null)?.result?.json?.turn;
  return typeof turn?.id === "string" ? turn.id : undefined;
}
function checkedOutcome(outcome: TurnOutcome, operation?: SavedOperation) {
  if (outcome.state !== "completed") throw new CliError(outcome.state === "gap" ? "STREAM_GAP" : "TURN_ATTENTION", "Turn did not complete successfully. Review the native outcome before taking further action.", outcome.state === "gap" ? 5 : 7, { ...(operation ? operationIdentity(operation) : {}), outcome });
  return outcome;
}
async function sendPreflight(ctx: Context, session: SessionRecord, allowError: boolean) {
  if (session.runtimeStatus === "running" || session.runtimeStatus === "waitingForInput") throw new CliError("SESSION_BUSY", "The session is running or awaiting input. Use steer or questions as appropriate.", 7);
  const native = session.harness === "codex" ? await nativeStatus(ctx.client, session) : undefined;
  if (!allowError && (session.runtimeStatus === "error" || native?.type === "systemError")) throw new CliError("NATIVE_ERROR", "The session reports a native error. Review status/history or the UI Terminal before using --allow-error deliberately.", 7, { sessionId: session.sessionId, native });
  if (native?.type === "active") throw new CliError("SESSION_BUSY", "Codex is already working. Use steer or questions as appropriate.", 7);
}
async function nativeStatus(client: AccessClient, session: SessionRecord) {
  const result = await client.sessions.readNativeHistory.query({ sessionId: session.sessionId, request: { harness: "codex", includeTurns: false, limit: 1 } });
  const status = (result.payload.json as { thread?: { status?: unknown } } | null)?.thread?.status;
  if (!status || typeof status !== "object" || Array.isArray(status) || typeof (status as { type?: unknown }).type !== "string") throw new CliError("NATIVE_STATUS_UNAVAILABLE", "The native status could not be established; inspect the session before continuing", 7);
  return status as { type: string };
}
async function getSession(client: AccessClient, id: SessionRecord["sessionId"]) {
  const session = await client.sessions.get.query(id);
  if (!session) throw new CliError("SESSION_NOT_FOUND", "No catalog session matches this exact ID", 4);
  return session;
}
async function selectHost(client: AccessClient, reference: string) {
  const hosts = await client.runtimeNodes.list.query();
  const exact = hosts.find(host => host.runtimeNodeId === reference);
  const matches = exact ? [exact] : hosts.filter(host => host.name === reference);
  if (matches.length !== 1) throw new CliError("HOST_SELECTION", "Use an exact runtime ID or unique exact host name from hosts", 4);
  const host = matches[0]!;
  if (host.presence !== "online" || host.reachability !== "reachable") throw new CliError("HOST_OFFLINE", "The selected host is not online and reachable", 4);
  return host;
}
async function selectProfile(client: AccessClient, host: RuntimeNodeDescriptor, harness: Harness) {
  const profiles = (await client.launchProfiles.list.query({ runtimeNodeId: host.runtimeNodeId, harness })).filter(p => p.available && p.providerId === "leo.local" && p.profileId === "workspace" && p.harnesses.includes(harness));
  if (profiles.length !== 1) throw new CliError("PROFILE_SELECTION", "Expected exactly one available leo.local/workspace launch profile", 4);
  return launchProfileIdentitySchema.parse(profiles[0]);
}
function codexOnly(session: SessionRecord) { if (session.harness !== "codex") throw new CliError("UNSUPPORTED_HARNESS", "Correlated wait currently supports Codex. Use history/watch for this harness."); }
function sessionSummary(s: SessionRecord) { return { sessionId: s.sessionId, runtimeNodeId: s.runtimeNodeId, harness: s.harness, cwd: s.cwd, title: s.metadata.values["agent.title"], catalogState: s.catalogState, availability: s.availability, runtimeStatus: s.runtimeStatus, settings: s.harnessSettings, lastActivityAt: s.lastActivityAt }; }
function cursorIdentity(ctx: Context, s: SessionRecord) { return { origin: ctx.origin, sessionId: s.sessionId, bindingRevision: s.bindingRevision, runtimeEpoch: s.runtimeEpoch }; }
async function readCursor(filename: string, ctx: Context, session: SessionRecord) {
  let value: unknown;
  try { value = await jsonFile(filename, ctx.signal); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return undefined; throw e; }
  const saved = value as { version?: number; identity?: unknown; cursor?: unknown } | null;
  if (saved?.version !== 1 || JSON.stringify(saved.identity) !== JSON.stringify(cursorIdentity(ctx, session))) throw new CliError("CURSOR_CONFLICT", "Cursor file belongs to another gateway, session or runtime binding");
  return accessAttachInputSchema.parse({ cursor: saved.cursor }).cursor;
}
async function saveCursor(filename: string, ctx: Context, session: SessionRecord, cursor: AccessWatchCursor) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify({ version: 1, identity: cursorIdentity(ctx, session), cursor }) + "\n"); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, filename); } finally { await unlink(temporary).catch(() => undefined); }
}
