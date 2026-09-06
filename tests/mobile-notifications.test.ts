import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessStreamItem, InteractionRecord, NativeEvent, SessionRecord, SourceId } from "@arduano/agent-multiplex-protocol";
import { MOBILE_LIMITS, MobileNotifications, mobileStorageScope, openMobileNotifications, validatePushSubscription, type MobileDeviceInput, type MobileNotification } from "../apps/server/src/mobile-notifications.js";
import { SESSION_ACTIVITY_LIMIT, activityMatchesSession } from "../packages/session-activity/src/contract.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposals.splice(0).map((close) => close())); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = id(40) as SourceId;
const controlId = id(41);
const categories = { completion: true, input: true, error: true };
const session = { sessionId: id(1), runtimeNodeId: id(2), adapterScopeId: "scope", harness: "codex", vendorSessionId: "root-thread", runtimeEpoch: id(3), bindingRevision: 1,
  availability: "active", runtimeStatus: "idle", catalogState: "open",
  metadata: { values: { "agent.title": "Manifold port" } }, metadataAuthority: { controlNodeId: controlId }, nativeSummary: {}, cwd: "/never-expose/workdir" } as SessionRecord;
const heartbeat = { kind: "heartbeat" } as AccessStreamItem;
function native(sequence: number, nativeType: string, json: unknown, changes: Partial<NativeEvent> = {}): NativeEvent {
  return { kind: "native", sessionId: session.sessionId, harness: "codex", runtimeEpoch: session.runtimeEpoch!, sequence, nativeType,
    payload: { encoding: "native-json-images-v1", images: [], json }, ...changes } as NativeEvent;
}
function completion(turn: string, sequence = 1): NativeEvent {
  return native(sequence, "turn/completed", { threadId: "root-thread", turn: { id: turn, status: "completed" } });
}
function input(n: number, fields: Partial<InteractionRecord> = {}): InteractionRecord {
  return { interactionId: id(n), sessionId: session.sessionId, harness: "codex", runtimeEpoch: session.runtimeEpoch,
    state: "pending", requestType: "approval", payload: { encoding: "native-json-images-v1", images: [], json: { params: { threadId: "root-thread", turnId: "one" } } }, ...fields } as InteractionRecord;
}
function changed(interaction: InteractionRecord): AccessStreamItem { return { kind: "control", change: { type: "interaction.changed", interaction } } as AccessStreamItem; }
export function pushDevice(suffix = "fixture"): MobileDeviceInput {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  return { name: "Test phone", enabled: true, categories, subscription: {
    endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  } };
}
async function fixture(options: { ready?: boolean; sender?: (payload: string) => Promise<void>; databasePath?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "leo-mobile-"));
  let now = 1_800_000_000_000;
  const sent: MobileNotification[] = [];
  const sender = vi.fn(async (_subscription, payload: string) => { sent.push(JSON.parse(payload)); await options.sender?.(payload); });
  const mobile = new MobileNotifications({ databasePath: options.databasePath ?? join(directory, "notifications.sqlite"), publicOrigin: "https://agents.example.test", publicKey: "fixture-public-key", sender, now: () => now, automaticDelivery: false });
  disposals.push(async () => { await mobile.close(); await rm(directory, { recursive: true, force: true }); });
  mobile.putDevice(id(10), pushDevice());
  mobile.setWatch(session.sessionId, true, session);
  mobile.synchronize(source, { listSessions: () => [session], listInteractions: () => [] }, [controlId]);
  if (options.ready !== false) mobile.observe(source, heartbeat);
  return { mobile, sent, sender, directory, advance: (ms: number) => { now += ms; } };
}

describe("personal watched-agent notifications", () => {
  it("does not notify on initial/reconnected replay, then emits only watched root completions", async () => {
    const f = await fixture({ ready: false });
    f.mobile.observe(source, completion("before"));
    expect(f.mobile.state().delivery.pending).toBe(0);
    f.mobile.observe(source, heartbeat);
    f.mobile.observe(source, completion("before"));
    f.mobile.observe(source, native(3, "turn/completed", { threadId: "child", turn: { id: "child", status: "completed" } }));
    f.mobile.observe(source, { ...completion("other"), sessionId: id(50) } as NativeEvent);
    f.mobile.observe(source, { ...completion("stale"), runtimeEpoch: id(51) } as NativeEvent);
    f.mobile.observe(source, native(6, "turn/completed", { threadId: "root-thread", turn: { id: "interrupt", status: "interrupted" } }));
    f.mobile.observe(source, completion("now", 7));
    await f.mobile.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ title: "Manifold port", body: "Finished working", sessionId: session.sessionId, kind: "completion" });
    expect(JSON.stringify(f.sent)).not.toContain("workdir");
    f.mobile.unavailable(source);
    f.mobile.synchronize(source, { listSessions: () => [session], listInteractions: () => [] }, [controlId]);
    f.mobile.observe(source, completion("reconnect-replay", 8));
    f.mobile.observe(source, heartbeat);
    f.mobile.observe(source, completion("reconnect-replay", 8));
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("classifies actionable failures, suppresses retry, deduplicates failed completion, and omits native messages", async () => {
    const f = await fixture();
    const error = { message: "private prompt details at /my/path", codexErrorInfo: "serverOverloaded" };
    f.mobile.observe(source, native(1, "error", { threadId: "root-thread", turnId: "failed", willRetry: true, error }));
    expect(f.mobile.state().delivery.pending).toBe(0);
    f.mobile.observe(source, native(2, "error", { threadId: "root-thread", turnId: "failed", willRetry: false, error }));
    f.mobile.observe(source, native(3, "turn/completed", { threadId: "root-thread", turn: { id: "failed", status: "failed", error } }));
    await f.mobile.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.body).toBe("Model at capacity");
    expect(JSON.stringify(f.sent)).not.toContain("private prompt");
    expect(JSON.stringify(f.sent)).not.toContain("/my/path");
  });

  it("seeds existing interactions and rejects nonblocking, resolved, and child questions", async () => {
    const f = await fixture();
    f.mobile.setWatch(session.sessionId, true, session, [input(70)]);
    f.mobile.observe(source, changed(input(70)));
    f.mobile.observe(source, changed(input(71, { state: "resolved" })));
    f.mobile.observe(source, changed(input(72, { payload: { encoding: "native-json-images-v1", images: [], json: { params: { isBlocking: false } } } })));
    f.mobile.observe(source, changed(input(73, { payload: { encoding: "native-json-images-v1", images: [], json: { params: { threadId: "child" } } } })));
    f.mobile.observe(source, changed(input(74)));
    f.mobile.observe(source, changed(input(74)));
    await f.mobile.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.kind).toBe("input");
  });

  it("preserves Copilot native loop completion, abort, error, and child semantics", async () => {
    const f = await fixture();
    const copilot = { ...session, harness: "copilot" } as SessionRecord;
    f.mobile.setWatch(session.sessionId, true, copilot);
    const emit = (seq: number, type: string, data: unknown, extra = {}) => f.mobile.observe(source, native(seq, type, { id: id(seq + 100), data, ...extra }, { harness: "copilot" }));
    emit(1, "session.idle", {}); // no observed loop, never invent completion
    emit(2, "assistant.turn_start", { turnId: "0" });
    emit(3, "session.idle", { aborted: true });
    emit(4, "assistant.turn_start", { turnId: "0" }, { agentId: "child" });
    emit(5, "session.idle", {}, { agentId: "child" });
    emit(6, "assistant.turn_start", { turnId: "0" });
    emit(7, "session.error", { message: "hidden", errorType: "capacity" });
    emit(8, "session.idle", {});
    await f.mobile.flush();
    emit(9, "assistant.turn_start", { turnId: "0" });
    emit(10, "session.idle", {});
    await f.mobile.flush();
    expect(f.sent.map((item) => item.kind)).toEqual(["error", "completion"]);
  });

  it("drops resolved attention and fences the exact native binding", async () => {
    const f = await fixture();
    f.mobile.observe(source, changed(input(76)));
    f.mobile.observe(source, changed(input(76, { state: "resolved" })));
    await f.mobile.flush(); expect(f.sent).toHaveLength(0);
    const replacement = { ...session, runtimeEpoch: id(80), bindingRevision: 2, vendorSessionId: "new-root" } as SessionRecord;
    f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session: replacement } } as AccessStreamItem);
    f.mobile.observe(source, completion("old-generation"));
    f.mobile.observe(source, native(1, "turn/completed", { threadId: "new-root", turn: { id: "new-generation", status: "completed" } }, { runtimeEpoch: id(80) as NativeEvent["runtimeEpoch"] }));
    await f.mobile.flush(); expect(f.sent).toHaveLength(1);
  });

  it("persists watches, devices, queued delivery, and native event dedupe through restart", async () => {
    const f = await fixture();
    f.mobile.observe(source, completion("once"));
    await f.mobile.flush();
    const second = new MobileNotifications({ databasePath: join(f.directory, "notifications.sqlite"), publicOrigin: "https://agents.example.test", publicKey: "fixture-public-key", sender: f.sender, automaticDelivery: false });
    try {
      second.synchronize(source, { listSessions: () => [session], listInteractions: () => [] }, [controlId]);
      second.observe(source, heartbeat); second.observe(source, completion("once"));
      await second.flush();
      expect(second.state().watchedSessionIds).toEqual([session.sessionId]);
      expect(second.state().devices).toHaveLength(1);
      expect(f.sent).toHaveLength(1);
    } finally { await second.close(); }
  });

  it("bounds pending delivery and payload bytes, expires old completions, and never waits for a slow push service", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture({ sender: () => waiting });
    const giantTitle = { ...session, metadata: { values: { "agent.title": "界".repeat(10_000) } } } as SessionRecord;
    f.mobile.setWatch(session.sessionId, true, giantTitle);
    f.mobile.observe(source, completion("slow"));
    const pending = f.mobile.flush();
    try {
      for (let i = 0; i < 1_050; i++) {
        const sibling = { ...session, sessionId: id(i + 1_000), vendorSessionId: `root-${i}` } as SessionRecord;
        f.mobile.setWatch(sibling.sessionId, true, sibling);
        f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session: sibling } } as AccessStreamItem);
        f.mobile.observe(source, native(1, "turn/completed", { threadId: sibling.vendorSessionId, turn: { id: `fast-${i}`, status: "completed" } }, { sessionId: sibling.sessionId }));
      }
      expect(f.mobile.state().delivery.pending).toBe(MOBILE_LIMITS.pending);
      expect(f.sent.every((payload) => Buffer.byteLength(JSON.stringify(payload)) <= MOBILE_LIMITS.payloadBytes)).toBe(true);
    } finally { release(); await pending; }
    f.advance(3_600_001); await f.mobile.flush();
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("retries transient errors with bounded backoff and removes gone subscriptions", async () => {
    let status = 503;
    const f = await fixture({ sender: async () => { throw Object.assign(new Error("secret endpoint"), { statusCode: status }); } });
    f.mobile.observe(source, completion("retry"));
    await f.mobile.flush(); await f.mobile.flush();
    expect(f.sender).toHaveBeenCalledTimes(1);
    expect(f.mobile.state().delivery.lastError).not.toContain("secret");
    f.advance(5_001); await f.mobile.flush();
    expect(f.sender).toHaveBeenCalledTimes(2);
    status = 410; f.advance(10_001); await f.mobile.flush();
    expect(f.mobile.state().devices).toHaveLength(0);
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("does not follow redirect failures and caps retry attempts", async () => {
    let status = 302;
    const f = await fixture({ sender: async () => { throw { statusCode: status }; } });
    f.mobile.observe(source, completion("redirect")); await f.mobile.flush();
    expect(f.mobile.state().delivery.pending).toBe(0);
    status = 503;
    f.mobile.observe(source, changed(input(88)));
    for (let i = 0; i < MOBILE_LIMITS.attempts; i++) { await f.mobile.flush(); f.advance(300_001); }
    expect(f.mobile.state().delivery.pending).toBe(0);
    expect(f.sender).toHaveBeenCalledTimes(MOBILE_LIMITS.attempts + 1);
  });

  it("honors device categories, disabling, revocation, and unwatch before delivery", async () => {
    const f = await fixture();
    const input = pushDevice(); input.categories = { ...categories, completion: false };
    f.mobile.putDevice(id(10), input);
    f.mobile.observe(source, completion("filtered"));
    expect(f.mobile.state().delivery.pending).toBe(0);
    f.mobile.test(id(10));
    f.mobile.putDevice(id(10), { ...input, enabled: false });
    expect(f.mobile.state().delivery.pending).toBe(0);
    f.mobile.putDevice(id(10), pushDevice());
    f.mobile.observe(source, completion("unwatch", 2));
    f.mobile.setWatch(session.sessionId, false);
    await f.mobile.flush(); expect(f.sent).toHaveLength(0);
    f.mobile.deleteDevice(id(10)); expect(f.mobile.state().devices).toHaveLength(0);
    expect(() => f.mobile.test(id(10))).toThrow();
  });

  it("prunes seven-day dedupe and stores operational rows only", async () => {
    const f = await fixture(); f.mobile.observe(source, completion("old")); await f.mobile.flush();
    f.advance(MOBILE_LIMITS.dedupeMs + 1); await f.mobile.flush();
    const db = new DatabaseSync(join(f.directory, "notifications.sqlite"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM mobile_dedupe").get()!.count).toBe(0);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)).not.toContain("sessions");
    } finally { db.close(); }
  });
});

describe("bounded observed session activity", () => {
  it("records native root completion for unwatched sessions without subscribing the owner to push", async () => {
    const f = await fixture(); f.mobile.setWatch(session.sessionId, false);
    f.mobile.observe(source, native(1, "turn/started", { threadId: "root-thread", turn: { id: "a" } }));
    expect(f.mobile.activity().sessions[0]?.kind).toBe("working");
    f.mobile.observe(source, completion("a", 2));
    const activity = f.mobile.activity().sessions[0]!;
    expect(activity.kind).toBe("completion");
    expect(activityMatchesSession(activity, session)).toBe(true);
    expect(f.mobile.state().delivery.pending).toBe(0);
    expect(JSON.stringify(f.mobile.activity())).not.toContain("workdir");
    expect(JSON.stringify(f.mobile.activity())).not.toContain("Manifold port");
    expect(f.mobile.state().watchedSessionIds).toEqual([]);
  });

  it("never infers completion from an idle catalog or initial replay", async () => {
    const f = await fixture({ ready: false });
    f.mobile.observe(source, completion("before", 1));
    f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session } } as AccessStreamItem);
    expect(f.mobile.activity().sessions).toEqual([]);
    f.mobile.observe(source, heartbeat);
    f.mobile.observe(source, completion("before", 1));
    expect(f.mobile.activity().sessions).toEqual([]);
    f.mobile.observe(source, completion("now", 2));
    expect(f.mobile.activity().sessions[0]?.kind).toBe("completion");
  });

  it("survives restart with exact bindings and fences replayed events", async () => {
    const f = await fixture(); f.mobile.observe(source, completion("persisted", 8));
    const saved = f.mobile.activity();
    const second = new MobileNotifications({ databasePath: join(f.directory, "notifications.sqlite"), publicOrigin: "https://agents.example.test", publicKey: "fixture", sender: f.sender, automaticDelivery: false });
    try {
      expect(second.activity()).toEqual(saved);
      second.synchronize(source, { listSessions: () => [session], listInteractions: () => [] }, [controlId]);
      second.observe(source, heartbeat);
      second.observe(source, native(2, "turn/started", { threadId: "root-thread", turn: { id: "old" } }));
      expect(second.activity()).toEqual(saved);
      const replacement = { ...session, bindingRevision: 2, runtimeEpoch: id(100) } as SessionRecord;
      second.observe(source, { kind: "control", change: { type: "session.upsert", session: replacement } } as AccessStreamItem);
      expect(second.activity().sessions).toEqual([]);
      expect(second.state().delivery.pending).toBe(0);
    } finally { await second.close(); }
  });

  it("drops a persisted terminal observation when reconnect discovers newer work", async () => {
    const f = await fixture(); f.mobile.observe(source, completion("old", 8));
    const second = new MobileNotifications({ databasePath: join(f.directory, "notifications.sqlite"), publicOrigin: "https://agents.example.test", publicKey: "fixture", sender: f.sender, automaticDelivery: false });
    try {
      second.synchronize(source, { listSessions: () => [{ ...session, runtimeStatus: "running" } as SessionRecord], listInteractions: () => [] }, [controlId]);
      expect(second.activity().sessions).toEqual([]);
      expect(second.state().delivery.pending).toBe(0);
    } finally { await second.close(); }
  });

  it("clears stale working after reconnect finds idle without manufacturing completion", async () => {
    const f = await fixture();
    f.mobile.observe(source, native(1, "turn/started", { threadId: "root-thread", turn: { id: "a" } }));
    f.mobile.unavailable(source);
    f.mobile.synchronize(source, { listSessions: () => [session], listInteractions: () => [] }, [controlId]);
    expect(f.mobile.activity().sessions).toEqual([]);
    f.mobile.observe(source, heartbeat);
    expect(f.mobile.activity().sessions).toEqual([]);
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("reconciles only this source's exact pending input on reconnect", async () => {
    const f = await fixture(); f.mobile.observe(source, changed(input(90)));
    const waiting = { ...session, runtimeStatus: "waitingForInput" } as SessionRecord;
    const before = f.mobile.activity();
    f.mobile.synchronize(source, { listSessions: () => [waiting], listInteractions: () => [input(90)] }, [controlId]);
    expect(f.mobile.activity()).toEqual(before);
    f.mobile.synchronize(source, { listSessions: () => [session], listInteractions: () => [input(90, { state: "resolved" })] }, [controlId]);
    expect(f.mobile.activity().sessions).toEqual([]);
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("baseline starts and completions retire stale terminal hints without new unread/push", async () => {
    const f = await fixture(); f.mobile.observe(source, completion("old", 1));
    f.mobile.synchronize(source, { listSessions: () => [session], listInteractions: () => [] }, [controlId]);
    expect(f.mobile.activity().sessions[0]?.kind).toBe("completion");
    f.mobile.observe(source, native(2, "turn/started", { threadId: "root-thread", turn: { id: "new" } }));
    expect(f.mobile.activity().sessions).toEqual([]);
    f.mobile.observe(source, completion("new", 3)); f.mobile.observe(source, heartbeat);
    f.mobile.observe(source, completion("new", 3));
    expect(f.mobile.activity().sessions).toEqual([]);
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("baseline completion of a newer turn clears an old error even when its start was missed", async () => {
    const f = await fixture();
    f.mobile.observe(source, native(1, "error", { threadId: "root-thread", turnId: "old", error: { codexErrorInfo: "serverOverloaded" } }));
    f.mobile.synchronize(source, { listSessions: () => [session], listInteractions: () => [] }, [controlId]);
    expect(f.mobile.activity().sessions[0]?.kind).toBe("error");
    f.mobile.observe(source, completion("new", 2));
    expect(f.mobile.activity().sessions).toEqual([]);
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("uses a positive running-to-idle catalog transition to retire missed working hints", async () => {
    const f = await fixture();
    f.mobile.observe(source, native(1, "turn/started", { threadId: "root-thread", turn: { id: "a" } }));
    f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session } } as AccessStreamItem);
    expect(f.mobile.activity().sessions[0]?.kind).toBe("working"); // stale idle before running acknowledges start
    f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session: { ...session, runtimeStatus: "running" } } } as AccessStreamItem);
    f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session } } as AccessStreamItem);
    expect(f.mobile.activity().sessions).toEqual([]);
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("Copilot baseline idle retires old working without a witnessed loop completion", async () => {
    const f = await fixture(); const copilot = { ...session, harness: "copilot", runtimeStatus: "running" } as SessionRecord;
    f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session: copilot } } as AccessStreamItem);
    f.mobile.observe(source, native(1, "assistant.turn_start", { id: "start-a", data: { turnId: "0" } }, { harness: "copilot" }));
    f.mobile.synchronize(source, { listSessions: () => [copilot], listInteractions: () => [] }, [controlId]);
    expect(f.mobile.activity().sessions[0]?.kind).toBe("working");
    f.mobile.observe(source, native(2, "session.idle", { id: "idle-a", data: {} }, { harness: "copilot" }));
    expect(f.mobile.activity().sessions).toEqual([]);
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("clears obsolete alerts on a new native turn and ignores delayed old-turn failures/completions", async () => {
    const f = await fixture();
    f.mobile.observe(source, native(1, "turn/started", { threadId: "root-thread", turn: { id: "a" } }));
    f.mobile.observe(source, completion("a", 2));
    expect(f.mobile.state().delivery.pending).toBe(1);
    f.mobile.observe(source, native(3, "turn/started", { threadId: "root-thread", turn: { id: "b" } }));
    expect(f.mobile.state().delivery.pending).toBe(0);
    const working = f.mobile.activity();
    f.mobile.observe(source, completion("a", 4));
    f.mobile.observe(source, native(5, "error", { threadId: "root-thread", turnId: "a", error: { codexErrorInfo: "serverOverloaded" } }));
    expect(f.mobile.activity()).toEqual(working);
    f.mobile.observe(source, completion("b", 6));
    expect(f.mobile.activity().sessions[0]?.kind).toBe("completion");
    expect(f.mobile.state().delivery.pending).toBe(1);
  });

  it("preserves errors through idle, exposes retrying, and records native interruption without a completion push", async () => {
    const f = await fixture();
    f.mobile.observe(source, native(1, "turn/started", { threadId: "root-thread", turn: { id: "a" } }));
    f.mobile.observe(source, native(2, "error", { threadId: "root-thread", turnId: "a", willRetry: true, error: { codexErrorInfo: "serverOverloaded", message: "secret" } }));
    expect(f.mobile.activity().sessions[0]).toMatchObject({ kind: "working", label: "Retrying" });
    expect(f.mobile.state().delivery.pending).toBe(0);
    f.mobile.observe(source, native(3, "item/agentMessage/delta", { threadId: "root-thread", turnId: "a", delta: "secret output" }));
    expect(f.mobile.activity().sessions[0]?.label).toBe("Working");
    f.mobile.observe(source, native(4, "error", { threadId: "root-thread", turnId: "a", error: { codexErrorInfo: "serverOverloaded", message: "secret" } }));
    f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session } } as AccessStreamItem);
    expect(f.mobile.activity().sessions[0]).toMatchObject({ kind: "error", label: "Model at capacity" });
    expect(JSON.stringify(f.mobile.activity())).not.toContain("secret");
    f.mobile.observe(source, native(5, "turn/started", { threadId: "root-thread", turn: { id: "b" } }));
    f.mobile.observe(source, native(6, "turn/completed", { threadId: "root-thread", turn: { id: "b", status: "interrupted" } }));
    expect(f.mobile.activity().sessions[0]?.kind).toBe("interrupted");
    expect(f.mobile.state().delivery.pending).toBe(0);
  });

  it("keeps source synchronization and laptop outages independent", async () => {
    const f = await fixture();
    const otherSource = id(200) as SourceId; const otherControl = id(201);
    const sibling = { ...session, sessionId: id(202), runtimeNodeId: id(203), metadataAuthority: { ...session.metadataAuthority, controlNodeId: otherControl } } as SessionRecord;
    f.mobile.setWatch(sibling.sessionId, true, sibling);
    const combined = { listSessions: () => [session, sibling], listInteractions: () => [] };
    f.mobile.synchronize(otherSource, combined, [otherControl]); f.mobile.observe(otherSource, heartbeat);
    f.mobile.observe(source, completion("personal", 1));
    f.mobile.observe(otherSource, { ...completion("laptop", 1), sessionId: sibling.sessionId } as NativeEvent);
    expect(f.mobile.activity().sessions).toHaveLength(2);
    f.mobile.unavailable(otherSource);
    f.mobile.synchronize(otherSource, combined, [otherControl]);
    f.mobile.observe(source, native(2, "turn/started", { threadId: "root-thread", turn: { id: "next" } }));
    f.mobile.observe(source, completion("next", 3));
    expect(f.mobile.activity().sessions.find(item => item.sessionId === session.sessionId)?.kind).toBe("completion");
    expect(f.mobile.activity().sessions.find(item => item.sessionId === sibling.sessionId)?.kind).toBe("completion");
    expect(f.mobile.state().delivery.pending).toBe(2);
  });

  it("bounds retained status to 500 and stores no token stream or full messages", async () => {
    const f = await fixture();
    for (let i = 0; i < SESSION_ACTIVITY_LIMIT + 10; i++) {
      const sibling = { ...session, sessionId: id(5000 + i), vendorSessionId: `root-${i}` } as SessionRecord;
      f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session: sibling } } as AccessStreamItem);
      f.mobile.observe(source, native(1, "turn/completed", { threadId: sibling.vendorSessionId, turn: { id: "a", status: "completed" } }, { sessionId: sibling.sessionId }));
    }
    expect(f.mobile.activity().sessions).toHaveLength(SESSION_ACTIVITY_LIMIT);
    expect(f.mobile.activity().sessions.some(item => item.sessionId === id(5000))).toBe(false);
    const database = new DatabaseSync(join(f.directory, "notifications.sqlite"));
    try { expect(database.prepare("SELECT count(*) AS count FROM mobile_activity").get()!.count).toBe(SESSION_ACTIVITY_LIMIT); }
    finally { database.close(); }
  });

  it("preserves Copilot root errors, recovery, abort and child distinctions", async () => {
    const f = await fixture();
    const copilot = { ...session, harness: "copilot" } as SessionRecord;
    f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session: copilot } } as AccessStreamItem);
    const emit = (seq: number, type: string, data: unknown, extra = {}) => f.mobile.observe(source, native(seq, type, { id: id(seq + 100), data, ...extra }, { harness: "copilot" }));
    emit(1, "session.idle", {});
    expect(f.mobile.activity().sessions).toEqual([]);
    emit(2, "assistant.turn_start", { turnId: "0" });
    const working = f.mobile.activity();
    emit(3, "session.error", { message: "child secret", errorType: "capacity" }, { agentId: "child" });
    emit(4, "session.idle", {}, { agentId: "child" });
    expect(f.mobile.activity()).toEqual(working);
    emit(5, "session.error", { message: "root secret", errorType: "capacity" });
    emit(6, "session.idle", {});
    expect(f.mobile.activity().sessions[0]?.kind).toBe("error");
    emit(7, "assistant.turn_start", { turnId: "0" });
    expect(f.mobile.activity().sessions[0]?.kind).toBe("working");
    expect(f.mobile.state().delivery.pending).toBe(0);
    emit(8, "session.idle", { aborted: true });
    expect(f.mobile.activity().sessions[0]?.kind).toBe("interrupted");
    emit(9, "assistant.turn_start", { turnId: "0" }); emit(10, "session.idle", {});
    expect(f.mobile.activity().sessions[0]?.kind).toBe("completion");
    expect(f.mobile.state().delivery.pending).toBe(1);
    expect(JSON.stringify(f.mobile.activity())).not.toContain("secret");
  });

  it("does not clear a same-turn retry or failure just because turn start repeats", async () => {
    const f = await fixture();
    f.mobile.observe(source, native(1, "error", { threadId: "root-thread", turnId: "a", willRetry: true, error: { codexErrorInfo: "serverOverloaded" } }));
    f.mobile.observe(source, native(2, "turn/started", { threadId: "root-thread", turn: { id: "a" } }));
    expect(f.mobile.activity().sessions[0]?.label).toBe("Retrying");
    f.mobile.observe(source, native(3, "error", { threadId: "root-thread", turnId: "a", error: { codexErrorInfo: "serverOverloaded" } }));
    f.mobile.observe(source, native(4, "turn/started", { threadId: "root-thread", turn: { id: "a" } }));
    expect(f.mobile.activity().sessions[0]?.kind).toBe("error");
    expect(f.mobile.state().delivery.pending).toBe(1);
  });

  it("removes resolved input and superseded failures without marking idle as finished", async () => {
    const f = await fixture();
    f.mobile.observe(source, changed(input(80)));
    expect(f.mobile.activity().sessions[0]?.kind).toBe("input");
    f.mobile.observe(source, changed(input(80, { state: "resolved" })));
    expect(f.mobile.activity().sessions).toEqual([]);
    f.mobile.observe(source, native(1, "error", { threadId: "root-thread", error: { codexErrorInfo: "serverOverloaded" } }));
    const running = { ...session, runtimeStatus: "running" } as SessionRecord;
    f.mobile.observe(source, { kind: "control", change: { type: "session.upsert", session: running } } as AccessStreamItem);
    expect(f.mobile.activity().sessions).toEqual([]);
    expect(f.mobile.state().delivery.pending).toBe(0);
  });
});

describe("mobile notification trust boundaries", () => {
  it("accepts only exact Chrome HTTPS endpoints and valid browser subscription keys", () => {
    const subscription = pushDevice().subscription;
    expect(() => validatePushSubscription(subscription)).not.toThrow();
    for (const endpoint of ["http://fcm.googleapis.com/fcm/send/fixture", "https://fcm.googleapis.com.evil.test/fcm/send/fixture", "https://127.0.0.1/fcm/send/fixture", "https://fcm.googleapis.com:444/fcm/send/fixture", "https://user@fcm.googleapis.com/fcm/send/fixture", "https://fcm.googleapis.com/fcm/send/fixture?secret=1", "https://fcm.googleapis.com/fcm/send/fixture#frag", "https://fcm.googleapis.com/other"]) {
      expect(() => validatePushSubscription({ ...subscription, endpoint })).toThrow();
    }
    expect(() => validatePushSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: "bad" } })).toThrow();
  });
  it("never exposes subscription material in configuration/device state and partitions local state by owner/workspace", async () => {
    const f = await fixture();
    expect(JSON.stringify(f.mobile.state())).not.toContain("fcm.googleapis.com");
    expect(JSON.stringify(f.mobile.state())).not.toContain("p256dh");
    expect(f.mobile.config("workspace", "OWNER@example.test", "https://agents.example.test").storageScope).toBe(mobileStorageScope("workspace", "owner@example.test"));
    expect(mobileStorageScope("workspace", "owner@example.test")).not.toBe(mobileStorageScope("other", "owner@example.test"));
    expect(mobileStorageScope("workspace", "owner@example.test")).not.toBe(mobileStorageScope("workspace", "other@example.test"));
    expect(f.mobile.config("workspace", "owner@example.test", "http://100.64.0.1:8444").enabled).toBe(false);
  });
  it("generates private stable VAPID keys once and reopens the operational database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "leo-mobile-keys-"));
    try {
      const first = await openMobileNotifications(directory, "https://agents.example.test", "owner@example.test");
      const key = first.publicKey; await first.close();
      const second = await openMobileNotifications(directory, "https://agents.example.test", "owner@example.test");
      expect(second.publicKey).toBe(key); await second.close();
      expect((await stat(join(directory, "mobile"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "mobile/vapid.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "mobile/notifications.sqlite"))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(join(directory, "mobile/vapid.json"), "utf8")).publicKey).toBe(key);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
