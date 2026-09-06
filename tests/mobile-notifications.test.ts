import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessStreamItem, InteractionRecord, NativeEvent, SessionRecord, SourceId } from "@arduano/agent-multiplex-protocol";
import { MOBILE_LIMITS, MobileNotifications, mobileStorageScope, openMobileNotifications, validatePushSubscription, type MobileDeviceInput, type MobileNotification } from "../apps/server/src/mobile-notifications.js";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposals.splice(0).map((close) => close())); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = id(40) as SourceId;
const categories = { completion: true, input: true, error: true };
const session = { sessionId: id(1), runtimeNodeId: id(2), adapterScopeId: "scope", harness: "codex", vendorSessionId: "root-thread", runtimeEpoch: id(3), bindingRevision: 1,
  metadata: { values: { "agent.title": "Manifold port" } }, nativeSummary: {}, cwd: "/never-expose/workdir" } as SessionRecord;
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
  mobile.synchronize(source, { listSessions: () => [session], listInteractions: () => [] });
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
    f.mobile.observe(source, completion("now"));
    await f.mobile.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ title: "Manifold port", body: "Finished working", sessionId: session.sessionId, kind: "completion" });
    expect(JSON.stringify(f.sent)).not.toContain("workdir");
    f.mobile.unavailable(source);
    f.mobile.synchronize(source, { listSessions: () => [session], listInteractions: () => [] });
    f.mobile.observe(source, completion("reconnect-replay"));
    f.mobile.observe(source, heartbeat);
    f.mobile.observe(source, completion("reconnect-replay"));
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
      second.synchronize(source, { listSessions: () => [session], listInteractions: () => [] });
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
    for (let i = 0; i < 1_050; i++) f.mobile.observe(source, completion(`fast-${i}`, i + 2));
    expect(f.mobile.state().delivery.pending).toBe(MOBILE_LIMITS.pending);
    expect(f.sent.every((payload) => Buffer.byteLength(JSON.stringify(payload)) <= MOBILE_LIMITS.payloadBytes)).toBe(true);
    release(); await pending;
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
    f.mobile.observe(source, completion("unwatch"));
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
