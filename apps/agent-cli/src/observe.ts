import { advanceAccessCursor, watchAccess, type AccessClient, type AccessWatchCursor } from "@arduano/agent-multiplex-client";
import type { AccessStreamItem, SessionRecord } from "@arduano/agent-multiplex-protocol";
import { codexFailure, failureFromEvent, type NativeFailure } from "../../../packages/native-errors/src/index.js";
import { CliError } from "./output.js";

export interface TurnOutcome {
  readonly state: "completed" | "failed" | "interrupted" | "needsInput" | "gap";
  readonly turnId?: string | undefined;
  readonly failure?: NativeFailure | undefined;
  readonly messages: readonly { id: string; text: string }[];
  readonly truncated: boolean;
  readonly cursor?: AccessWatchCursor | undefined;
}

interface TurnBuffer {
  readonly messages: Map<string, { id: string; text: string }>;
  readonly interactions: Set<string>;
  bytes: number;
  terminal?: { state: "completed" | "failed" | "interrupted"; failure?: NativeFailure | undefined } | undefined;
  priorFailure?: NativeFailure | undefined;
}
const MAX_TURNS = 64;
const MAX_MESSAGES = 256;
const MAX_MESSAGE_BYTES = 65_536;

export function observeTurn(client: AccessClient, session: SessionRecord, options: { signal: AbortSignal; cursor?: AccessWatchCursor | undefined }) {
  const turns = new Map<string, TurnBuffer>();
  const interactions = new Map<string, string>();
  let messageBytes = 0;
  let messageCount = 0;
  let evicted = false;
  let truncated = false;
  let cursor = options.cursor;
  let activeTurn: string | undefined;
  let gap = false;
  let terminalError: unknown;
  let failed = false;
  let closed = false;
  let readyReceived = false;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A stream may fail before the caller reaches `await ready`.
  void ready.catch(() => undefined);
  let waiter: { id: string; resolve: (outcome: TurnOutcome) => void; reject: (error: unknown) => void } | undefined;
  const abort = () => reject(options.signal.reason ?? new CliError("WATCH_ABORTED", "Turn observation was cancelled", 4));
  function stop() { options.signal.removeEventListener("abort", abort); controller.abort(); }
  function reject(error: unknown) {
    if (failed) return;
    failed = true; terminalError = error;
    readyReject(error); waiter?.reject(error); waiter = undefined;
    stop();
  }
  function gapOutcome(): TurnOutcome { return { state: "gap", messages: [], truncated, cursor }; }
  function markGap() {
    gap = true;
    if (!readyReceived) { reject(new CliError("WATCH_GAP", "The stream has a gap; recover session state before sending", 5, { cursor })); return; }
    waiter?.resolve(gapOutcome()); waiter = undefined;
    stop();
  }
  function buffer(id: string): TurnBuffer | undefined {
    if (!validId(id)) { truncated = true; markGap(); return undefined; }
    const existing = turns.get(id);
    if (existing) { turns.delete(id); turns.set(id, existing); return existing; }
    if (turns.size >= MAX_TURNS) {
      const oldest = [...turns.keys()].find((key) => key !== waiter?.id)!;
      const discarded = turns.get(oldest)!;
      messageBytes -= discarded.bytes;
      messageCount -= discarded.messages.size;
      for (const interactionId of discarded.interactions) interactions.delete(interactionId);
      turns.delete(oldest); evicted = true; truncated = true;
    }
    const created: TurnBuffer = { messages: new Map(), interactions: new Set(), bytes: 0 };
    turns.set(id, created); return created;
  }
  function outcome(id: string): TurnOutcome | undefined {
    const turn = turns.get(id);
    if (!turn) return undefined;
    const state = turn.terminal?.state ?? (turn.interactions.size ? "needsInput" : undefined);
    return state ? { state, turnId: id, failure: turn.terminal?.failure, messages: [...turn.messages.values()], truncated, cursor } : undefined;
  }
  function settle(id: string) {
    const result = outcome(id);
    if (waiter?.id === id && result) { waiter.resolve(result); waiter = undefined; }
  }
  function finish(id: string, terminal: NonNullable<TurnBuffer["terminal"]>) {
    const turn = buffer(id);
    if (!turn) return;
    turn.terminal = terminal;
    for (const interactionId of turn.interactions) interactions.delete(interactionId);
    turn.interactions.clear();
    if (activeTurn === id) activeTurn = undefined;
    settle(id);
  }
  function addMessage(turnId: string, id: string, text: string) {
    const turn = buffer(turnId);
    if (!turn) return;
    if (!validId(id)) { truncated = true; return; }
    const previous = turn.messages.get(id);
    if (!previous && messageCount >= MAX_MESSAGES) { truncated = true; return; }
    const previousBytes = previous ? Buffer.byteLength(previous.id) + Buffer.byteLength(previous.text) : 0;
    const idBytes = Buffer.byteLength(id);
    const remaining = MAX_MESSAGE_BYTES - messageBytes + previousBytes - idBytes;
    if (remaining < 0) { truncated = true; return; }
    const bytes = Buffer.from(text);
    const retained = new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true });
    truncated ||= bytes.length > remaining;
    const addedBytes = idBytes + Buffer.byteLength(retained) - previousBytes;
    messageBytes += addedBytes; turn.bytes += addedBytes;
    if (!previous) messageCount += 1;
    turn.messages.set(id, { id, text: retained });
  }
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const watcher = watchAccess(client.sessions.watch, {
    sessions: [session.sessionId], includeNative: true, signal,
    ...(cursor ? { cursor } : {}), maxPendingItems: 256,
    shouldRetry: retryStream,
    onStateChange(state) { if (state.state === "failed") reject(state.error); },
    onItem(item) {
      if (closed || failed || gap) return;
      cursor = advanceAccessCursor(cursor, item);
      if (item.kind === "heartbeat") { readyReceived = true; readyResolve(); return; }
      if (item.kind === "streamReset" || item.kind === "nativeGap" && item.sessionId === session.sessionId) {
        markGap(); return;
      }
      if (item.kind === "control" && item.change.type === "session.upsert" && item.change.session.sessionId === session.sessionId) {
        const current = item.change.session;
        if (current.runtimeEpoch !== session.runtimeEpoch || current.bindingRevision !== session.bindingRevision ||
            current.vendorSessionId !== session.vendorSessionId || current.runtimeNodeId !== session.runtimeNodeId ||
            current.adapterScopeId !== session.adapterScopeId || current.harness !== session.harness) markGap();
        return;
      }
      if (item.kind === "control" && item.change.type === "interaction.changed") {
        const interaction = item.change.interaction;
        if (interaction.sessionId !== session.sessionId || interaction.runtimeEpoch !== session.runtimeEpoch || interaction.harness !== session.harness) return;
        const previousTurn = interactions.get(interaction.interactionId);
        if (previousTurn) {
          turns.get(previousTurn)?.interactions.delete(interaction.interactionId);
          interactions.delete(interaction.interactionId);
        }
        if (interaction.state !== "pending") return;
        const json = object(interaction.payload.json);
        const params = object(json?.params) ?? json;
        if (params?.isBlocking === false || typeof params?.threadId === "string" && params.threadId !== session.vendorSessionId) return;
        const id = typeof params?.turnId === "string" ? params.turnId : activeTurn;
        if (!id) return;
        if (interactions.size >= 128) { truncated = true; markGap(); return; }
        const turn = buffer(id);
        if (!turn || turn.terminal) return;
        turn.interactions.add(interaction.interactionId);
        interactions.set(interaction.interactionId, id);
        settle(id); return;
      }
      if (item.kind !== "native" || item.harness !== "codex" || item.sessionId !== session.sessionId || item.runtimeEpoch !== session.runtimeEpoch) return;
      const payload = object(item.payload.json);
      if (payload?.threadId !== session.vendorSessionId) return;
      const turn = object(payload.turn);
      if (item.nativeType === "turn/started" && typeof turn?.id === "string") {
        const started = buffer(turn.id);
        if (started && !started.terminal) activeTurn = turn.id;
      }
      if (item.nativeType === "item/completed" && typeof payload.turnId === "string") {
        const native = object(payload.item);
        if (native?.type === "agentMessage" && typeof native.text === "string" && typeof native.id === "string") {
          addMessage(payload.turnId, native.id, native.text);
        }
      }
      const nativeFailure = failureFromEvent(item);
      if (nativeFailure?.turnId) {
        const current = buffer(nativeFailure.turnId);
        if (!current) return;
        const error = turn?.error ?? payload.error;
        // Keep the settled form while Codex retries, including structured error
        // classification, so a later completion may omit the repeated details.
        const settledFailure = error == null && current.priorFailure ? current.priorFailure
          : codexFailure(error ?? payload, { ...nativeFailure, willRetry: false });
        current.priorFailure = settledFailure;
        if (!nativeFailure.willRetry) finish(nativeFailure.turnId, { state: "failed", failure: settledFailure });
        return;
      }
      if (item.nativeType === "turn/completed" && typeof turn?.id === "string" && ["completed", "interrupted"].includes(String(turn.status))) {
        finish(turn.id, { state: turn.status as "completed" | "interrupted" });
      }
    },
  });
  void watcher.done.then(() => {
    if (!closed && !failed && !gap) reject(new CliError("WATCH_CLOSED", "The observer stopped", 4));
  }, reject);
  return {
    ready, get cursor() { return cursor; },
    wait(turnId: string): Promise<TurnOutcome> {
      const result = ready.then(() => {
        if (failed) throw terminalError;
        if (closed) throw new CliError("WATCH_CLOSED", "The observer is closed", 4);
        if (!validId(turnId)) throw new CliError("INVALID_TURN_ID", "A bounded native turn ID is required", 2);
        if (gap || evicted && !turns.has(turnId)) return gapOutcome();
        const completed = outcome(turnId);
        if (completed) return completed;
        if (waiter) throw new CliError("WATCH_BUSY", "Only one turn can be awaited", 4);
        return new Promise<TurnOutcome>((resolve, reject) => { waiter = { id: turnId, resolve, reject }; });
      });
      void result.catch(() => undefined);
      return result;
    },
    close() {
      if (closed) return;
      closed = true; reject(new CliError("WATCH_CLOSED", "The observer closed", 4));
      turns.clear(); interactions.clear();
    },
  };
}

export async function streamEvents(client: AccessClient, session: SessionRecord, options: {
  signal: AbortSignal; cursor?: AccessWatchCursor | undefined; maximum: number;
  write: (item: AccessStreamItem, cursor: AccessWatchCursor | undefined) => Promise<void>;
}) {
  if (!Number.isSafeInteger(options.maximum) || options.maximum < 1) throw new CliError("INVALID_LIMIT", "Event maximum must be a positive integer", 2);
  options.signal.throwIfAborted();
  let cursor = options.cursor; let count = 0;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const watcher = watchAccess(client.sessions.watch, {
    sessions: [session.sessionId], includeNative: true, signal,
    ...(cursor ? { cursor } : {}), maxPendingItems: 256,
    shouldRetry: retryStream,
    async onItem(item) {
      const next = advanceAccessCursor(cursor, item);
      await writeUntilAbort(options.write(item, next), signal); cursor = next;
      if (item.kind === "streamReset" || item.kind === "nativeGap") throw new CliError("STREAM_GAP", "Stream continuity was lost; reconcile history and state before continuing", 5, { cursor });
      if (++count >= options.maximum) controller.abort();
    },
  });
  try { await watcher.done; options.signal.throwIfAborted(); return { cursor, count }; }
  finally { watcher.stop(); }
}
function writeUntilAbort(write: Promise<void>, signal: AbortSignal): Promise<void> {
  const result = new Promise<void>((resolve, reject) => {
    const abort = () => { reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void write.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
  return result;
}
function validId(value: string): boolean { return value.length > 0 && value.length <= 1_024 && Buffer.byteLength(value) <= 1_024; }
function retryStream(error: unknown): boolean {
  const record = object(error);
  const code = object(record?.data)?.code ?? object(object(record?.shape)?.data)?.code ?? record?.code;
  return !["UNAUTHORIZED", "FORBIDDEN", "PERMISSION_DENIED", "BAD_REQUEST", "NOT_FOUND", "METHOD_NOT_SUPPORTED"].includes(String(code));
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
