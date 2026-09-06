import { ECDH, createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import webPush from "web-push";
import { z } from "zod";
import type { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import type { AccessStreamItem, InteractionRecord, SessionRecord, SourceId } from "@arduano/agent-multiplex-protocol";
import { failureFromEvent } from "../../../packages/native-errors/src/index.js";
import { SESSION_ACTIVITY_LIMIT, activityMatchesSession, type SessionActivity, type SessionActivityBinding, type SessionActivityKind, type SessionActivityResponse } from "../../../packages/session-activity/src/contract.js";

export const MOBILE_LIMITS = { pending: 1_000, devices: 32, watches: 2_000, payloadBytes: 2_048, dedupeMs: 7 * 86_400_000, dedupeRecords: 100_000, attempts: 6 } as const;
export const mobileCategoriesSchema = z.object({ completion: z.boolean(), input: z.boolean(), error: z.boolean() }).strict();
const subscriptionSchema = z.object({
  endpoint: z.string().max(2_048), expirationTime: z.number().finite().nullable().optional(),
  keys: z.object({ p256dh: z.string().regex(/^[\w-]{87}$/), auth: z.string().regex(/^[\w-]{22}$/) }).strict(),
}).strict();
export const mobileDeviceInputSchema = z.object({
  name: z.string().trim().min(1).max(80), subscription: subscriptionSchema,
  enabled: z.boolean(), categories: mobileCategoriesSchema,
}).strict();
export type MobileDeviceInput = z.infer<typeof mobileDeviceInputSchema>;
export interface MobileDevice {
  id: string; name: string; enabled: boolean; categories: z.infer<typeof mobileCategoriesSchema>; createdAt: string; lastSeenAt: string;
}
export type MobileKind = "completion" | "input" | "error" | "test";
export interface MobileNotification {
  version: 1; eventId: string; title: string; body: string; sessionId: string | null; kind: MobileKind; tag: string; createdAt: string; expiresAt: string;
}
export type PushSender = (subscription: MobileDeviceInput["subscription"], payload: string, ttlSeconds: number, topic: string) => Promise<void>;
interface DeviceRow { id: string; name: string; enabled: number; categories: string; subscription: string; created_at: number; last_seen_at: number }
interface DeliveryRow { id: number; device_id: string; event_id: string; session_id: string | null; payload: string; expires_at: number; attempts: number }
interface ThinSession extends SessionActivityBinding {
  id: string; sourceId: SourceId; binding: string; epoch: string | null; harness: SessionRecord["harness"]; vendorId: string; title: string;
  turn?: string | undefined; failed?: boolean | undefined; retrying?: boolean | undefined; sequence?: number | undefined;
  runtimeStatus: SessionRecord["runtimeStatus"];
}

export function mobileStorageScope(instanceId: string, ownerEmail: string): string {
  return hash(JSON.stringify(["leo-mobile-storage-v1", instanceId, ownerEmail.trim().toLowerCase()]));
}

/** This allowlist deliberately supports Chrome/Android only. HTTPS uses the Node
 * client directly, without proxies or redirects; user input never selects a host. */
export function validatePushSubscription(subscription: MobileDeviceInput["subscription"]): void {
  const url = new URL(subscription.endpoint);
  if (url.protocol !== "https:" || url.hostname !== "fcm.googleapis.com" || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:.-]+$/.test(url.pathname) || url.href !== subscription.endpoint ||
      Buffer.from(subscription.keys.p256dh, "base64url").byteLength !== 65 || Buffer.from(subscription.keys.p256dh, "base64url")[0] !== 4 ||
      Buffer.from(subscription.keys.auth, "base64url").byteLength !== 16) throw new TypeError("Invalid Chrome push subscription");
  ECDH.convertKey(Buffer.from(subscription.keys.p256dh, "base64url"), "prime256v1");
}

export async function openMobileNotifications(directory: string, publicOrigin: string, ownerEmail: string): Promise<MobileNotifications> {
  const privateDirectory = join(directory, "mobile");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  await chmod(privateDirectory, 0o700);
  const keyPath = join(privateDirectory, "vapid.json");
  let keys: { publicKey: string; privateKey: string };
  try { keys = JSON.parse(await readFile(keyPath, "utf8")) as typeof keys; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    keys = webPush.generateVAPIDKeys();
    await writeFile(keyPath, JSON.stringify(keys) + "\n", { mode: 0o600, flag: "wx" });
  }
  await chmod(keyPath, 0o600);
  // Validate persisted key material before serving requests, without printing it.
  webPush.generateRequestDetails({ endpoint: "https://fcm.googleapis.com/fcm/send/key-validation", keys: { p256dh: "", auth: "" } }, undefined, {
    vapidDetails: { subject: `mailto:${ownerEmail}`, ...keys }, TTL: 1,
  });
  const databasePath = join(privateDirectory, "notifications.sqlite");
  const notifications = new MobileNotifications({ databasePath, publicOrigin, publicKey: keys.publicKey,
    sender: createPushSender(keys, ownerEmail) });
  await chmod(databasePath, 0o600);
  return notifications;
}

function createPushSender(keys: { publicKey: string; privateKey: string }, ownerEmail: string): PushSender {
  return async (subscription, payload, ttlSeconds, topic) => {
    validatePushSubscription(subscription);
    const details = webPush.generateRequestDetails({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
      vapidDetails: { subject: `mailto:${ownerEmail}`, ...keys }, TTL: ttlSeconds, urgency: "normal", topic,
    });
    await new Promise<void>((resolve, reject) => {
      const request = httpsRequest(details.endpoint, { method: details.method, headers: details.headers, timeout: 10_000 }, (response) => {
        // Push-service bodies may contain endpoints or provider details. Discard
        // bounded bytes and report only the status code to the delivery loop.
        let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > 4_096) response.destroy(); });
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(); else reject(Object.assign(new Error("Push service rejected delivery"), { statusCode: status }));
        });
      });
      const deadline = setTimeout(() => request.destroy(new Error("Push delivery timed out")), 10_000);
      deadline.unref();
      request.once("close", () => clearTimeout(deadline));
      request.on("timeout", () => request.destroy(new Error("Push service timed out")));
      request.on("error", reject);
      request.end(details.body);
    });
  };
}

/** Personal operational state only. Stores one bounded status observation per
 * session, never catalog authority, native payloads, messages, paths or credentials. */
export class MobileNotifications {
  readonly #db: DatabaseSync;
  readonly #sender: PushSender;
  readonly #now: () => number;
  readonly #sessions = new Map<string, ThinSession>();
  readonly #ready = new Set<SourceId>();
  readonly #watched = new Set<string>();
  readonly publicKey: string;
  readonly publicOrigin: string;
  #timer: ReturnType<typeof setInterval> | undefined;
  #flushing: Promise<void> | undefined;
  #closed = false;
  #lastError: string | undefined;
  #lastPrune = 0;
  #dedupeCount = 0;

  constructor(options: { databasePath: string; publicOrigin: string; publicKey: string; sender: PushSender; now?: () => number; automaticDelivery?: boolean }) {
    this.publicOrigin = options.publicOrigin;
    this.publicKey = options.publicKey;
    this.#sender = options.sender;
    this.#now = options.now ?? Date.now;
    this.#db = new DatabaseSync(options.databasePath);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS mobile_migrations(name TEXT PRIMARY KEY);
    `);
    if (!this.#db.prepare("SELECT 1 FROM mobile_migrations WHERE name=?").get("001-notifications")) {
      this.#db.exec(`BEGIN;
        CREATE TABLE mobile_devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,subscription TEXT NOT NULL,enabled INTEGER NOT NULL,categories TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL);
        CREATE TABLE mobile_watches(session_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
        CREATE TABLE mobile_dedupe(event_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
        CREATE TABLE mobile_delivery(id INTEGER PRIMARY KEY AUTOINCREMENT,device_id TEXT NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,event_id TEXT NOT NULL,session_id TEXT,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,UNIQUE(device_id,event_id));
        CREATE INDEX mobile_delivery_due ON mobile_delivery(next_at);
        CREATE INDEX mobile_dedupe_age ON mobile_dedupe(created_at);
        INSERT INTO mobile_migrations VALUES('001-notifications'); COMMIT;`);
    }
    if (!this.#db.prepare("SELECT 1 FROM mobile_migrations WHERE name=?").get("002-session-activity")) {
      this.#db.exec(`BEGIN;
        CREATE TABLE mobile_activity(session_id TEXT PRIMARY KEY,binding TEXT NOT NULL,payload TEXT NOT NULL,observed_at INTEGER NOT NULL,native_sequence INTEGER,turn_id TEXT);
        CREATE INDEX mobile_activity_recent ON mobile_activity(observed_at);
        INSERT INTO mobile_migrations VALUES('002-session-activity'); COMMIT;`);
    }
    for (const row of this.#db.prepare("SELECT session_id FROM mobile_watches").all()) this.#watched.add(String(row.session_id));
    this.#prune();
    if (options.automaticDelivery !== false) {
      this.#timer = setInterval(() => { void this.flush(); }, 1_000);
      this.#timer.unref();
    }
  }

  config(instanceId: string, ownerEmail: string, requestOrigin: string) {
    return { enabled: this.publicOrigin.startsWith("https:") && requestOrigin === this.publicOrigin,
      publicKey: this.publicKey, origin: this.publicOrigin, storageScope: mobileStorageScope(instanceId, ownerEmail) };
  }
  state() {
    return { devices: (this.#db.prepare("SELECT * FROM mobile_devices ORDER BY created_at").all() as unknown as DeviceRow[]).map(publicDevice),
      watchedSessionIds: [...this.#watched], delivery: { pending: this.#count("mobile_delivery"), ...(this.#lastError ? { lastError: this.#lastError } : {}) } };
  }
  activity(): SessionActivityResponse {
    return { sessions: this.#db.prepare("SELECT payload FROM mobile_activity ORDER BY observed_at DESC,rowid DESC LIMIT ?").all(SESSION_ACTIVITY_LIMIT)
      .map(row => JSON.parse(String(row.payload)) as SessionActivity) };
  }
  putDevice(id: string, input: MobileDeviceInput): MobileDevice {
    input = mobileDeviceInputSchema.parse(input);
    validatePushSubscription(input.subscription);
    const previous = this.#db.prepare("SELECT * FROM mobile_devices WHERE id=?").get(id) as unknown as DeviceRow | undefined;
    if (!previous && this.#count("mobile_devices") >= MOBILE_LIMITS.devices) throw new TypeError("Remove an old device before registering another");
    const now = this.#now();
    // One subscription is one device, even after local browser data is cleared.
    for (const row of this.#db.prepare("SELECT id,subscription FROM mobile_devices WHERE id<>?").all(id)) {
      if ((JSON.parse(String(row.subscription)) as MobileDeviceInput["subscription"]).endpoint === input.subscription.endpoint) this.deleteDevice(String(row.id));
    }
    this.#db.prepare(`INSERT INTO mobile_devices VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,subscription=excluded.subscription,enabled=excluded.enabled,categories=excluded.categories,last_seen_at=excluded.last_seen_at`)
      .run(id, input.name, JSON.stringify(input.subscription), Number(input.enabled), JSON.stringify(input.categories), previous?.created_at ?? now, now);
    if (!input.enabled) this.#db.prepare("DELETE FROM mobile_delivery WHERE device_id=?").run(id);
    return publicDevice(this.#db.prepare("SELECT * FROM mobile_devices WHERE id=?").get(id) as unknown as DeviceRow);
  }
  deleteDevice(id: string): void { this.#db.prepare("DELETE FROM mobile_devices WHERE id=?").run(id); }
  setWatch(sessionId: string, watched: boolean, session?: SessionRecord, interactions: InteractionRecord[] = []): string[] {
    if (watched) {
      if (!this.#watched.has(sessionId) && this.#watched.size >= MOBILE_LIMITS.watches) throw new TypeError("Watch limit reached");
      this.#db.prepare("INSERT OR IGNORE INTO mobile_watches VALUES(?,?)").run(sessionId, this.#now());
      this.#watched.add(sessionId);
      if (session) this.#remember(session, this.#sessions.get(sessionId)?.sourceId);
      const known = this.#sessions.get(sessionId);
      if (known) for (const interaction of interactions) if (interaction.sessionId === sessionId && interaction.runtimeEpoch === known.epoch) this.#seen(this.#interactionId(known, interaction));
    } else {
      this.#db.prepare("DELETE FROM mobile_watches WHERE session_id=?").run(sessionId);
      this.#db.prepare("DELETE FROM mobile_delivery WHERE session_id=?").run(sessionId);
      this.#watched.delete(sessionId);
    }
    return [...this.#watched];
  }
  test(id: string): void {
    const device = this.#db.prepare("SELECT * FROM mobile_devices WHERE id=? AND enabled=1").get(id) as unknown as DeviceRow | undefined;
    if (!device) throw new TypeError("Enable this registered device before testing notifications");
    this.#queue({ eventId: hash(randomUUID()), title: "Leo / agents", body: "Notifications are working", sessionId: null, kind: "test" }, [device]);
  }

  /** Called after a successful snapshot, never while owning its native payloads. */
  synchronize(sourceId: SourceId, projection: Pick<AccessGatewayProjection, "listSessions" | "listInteractions">, coveredControlNodeIds: readonly string[]): void {
    this.#ready.delete(sourceId);
    const covered = new Set(coveredControlNodeIds);
    const sourceSessions = projection.listSessions().filter(session => covered.has(session.metadataAuthority.controlNodeId));
    const ids = new Set<string>(sourceSessions.map(session => session.sessionId));
    for (const [id, session] of this.#sessions) if (session.sourceId === sourceId && !ids.has(id)) {
      this.#sessions.delete(id);
      this.#forgetActivity(id);
    }
    for (const session of sourceSessions) {
      this.#remember(session, sourceId);
      const known = this.#sessions.get(session.sessionId);
      // A catalog snapshot has no native active-turn identity. Work may have
      // advanced while disconnected; keep sequence fences, not an old turn fence.
      if (known) { known.turn = undefined; known.retrying = false; }
    }
    const interactions = projection.listInteractions();
    const pending = new Set<string>();
    // A pending question that existed before connection/watch is a baseline, not
    // a new notification. Persisting its identity also fences later upserts.
    for (const interaction of interactions) {
      const session = this.#sessions.get(interaction.sessionId);
      if (session?.sourceId !== sourceId || interaction.runtimeEpoch !== session.epoch || interaction.harness !== session.harness) continue;
      const eventId = this.#interactionId(session, interaction);
      this.#seen(eventId);
      if (interaction.state === "pending" && this.#blockingRootInteraction(session, interaction)) pending.add(eventId);
    }
    // A fresh source snapshot can disprove an old in-progress hint after events
    // were missed offline. It cannot prove that the work completed successfully.
    for (const session of sourceSessions) {
      const activity = this.#activityFor(session.sessionId);
      if (activity?.kind === "working" && session.runtimeStatus !== "running" || activity?.kind === "input" && !pending.has(activity.eventId)) {
        this.#forgetActivity(session.sessionId);
      }
    }
  }
  unavailable(sourceId: SourceId): void { this.#ready.delete(sourceId); }

  /** Only call for projection.ingest(...) === true. Extraction is synchronous;
   * delivery runs independently, retaining only <=2 KiB notification records. */
  observe(sourceId: SourceId, item: AccessStreamItem): void {
    if (this.#closed) return;
    if (item.kind === "heartbeat") { this.#ready.add(sourceId); return; }
    if (item.kind === "control" && item.change.type === "session.upsert") {
      const record = item.change.session;
      this.#remember(record, sourceId);
      return;
    }
    if (item.kind === "control" && item.change.type === "interaction.changed") {
      const interaction = item.change.interaction;
      const session = this.#sessions.get(interaction.sessionId);
      if (!session || session.sourceId !== sourceId || interaction.runtimeEpoch !== session.epoch || interaction.harness !== session.harness) return;
      if (interaction.state !== "pending") {
        this.#db.prepare("DELETE FROM mobile_delivery WHERE event_id=?").run(this.#interactionId(session, interaction));
        const activity = this.#activityFor(session.id);
        if (activity?.eventId === this.#interactionId(session, interaction)) this.#forgetActivity(session.id, false);
        return;
      }
      if (!this.#blockingRootInteraction(session, interaction)) return;
      if (this.#ready.has(sourceId)) this.#recordActivity(session, this.#interactionId(session, interaction), "input", "Needs your input");
      else this.#invalidateBaselineActivity(session.id, this.#interactionId(session, interaction));
      this.#signal(session, this.#interactionId(session, interaction), "input", "Needs your input", this.#ready.has(sourceId));
      return;
    }
    if (item.kind !== "native") return;
    const session = this.#sessions.get(item.sessionId);
    if (!session || session.sourceId !== sourceId || item.runtimeEpoch !== session.epoch || item.harness !== session.harness || item.sequence <= (session.sequence ?? -1)) return;
    session.sequence = item.sequence;
    const payload = object(item.payload.json);
    if (item.harness === "codex" && payload?.threadId !== session.vendorId || item.harness === "copilot" && typeof payload?.agentId === "string") return;
    const turn = object(payload?.turn);
    const data = object(payload?.data);
    const ready = this.#ready.has(sourceId);
    if (!ready && item.harness === "codex" && item.nativeType === "thread/status/changed" && object(payload?.status)?.type === "active") {
      this.#invalidateBaselineActivity(session.id, hash(`${session.binding}:active:${item.sequence}`));
      session.failed = false; session.retrying = false; session.turn = undefined;
      return;
    }
    if (item.harness === "codex" && item.nativeType === "turn/started" || item.harness === "copilot" && item.nativeType === "assistant.turn_start") {
      // Copilot turnId is a loop counter, not globally unique; the native event
      // UUID identifies this concrete turn across restarts.
      const next = item.harness === "codex" ? string(turn?.id) : string(payload?.id) ?? `${item.runtimeEpoch}:${item.sequence}`;
      const newTurn = next !== session.turn;
      if (newTurn) { session.failed = false; session.retrying = false; }
      session.turn = next;
      if (ready && !session.failed && !session.retrying) this.#recordActivity(session, hash(`${session.binding}:working:${session.turn ?? item.sequence}`), "working", "Working", item.sequence);
      if (!ready && newTurn) this.#invalidateBaselineActivity(session.id, hash(`${session.binding}:working:${session.turn ?? item.sequence}`));
      if (newTurn) this.#cancelSuperseded(session.id);
      return;
    }
    if (item.harness === "codex" && item.nativeType === "turn/completed" && session.turn && turn?.id !== session.turn) return;
    const failure = failureFromEvent(item);
    if (failure && item.harness === "codex" && session.turn && failure.turnId && failure.turnId !== session.turn) return;
    if (failure && item.harness === "codex" && !session.turn && failure.turnId) session.turn = failure.turnId;
    if (failure?.willRetry) {
      session.retrying = true;
      if (ready) this.#recordActivity(session, hash(`${session.binding}:retry:${failure.id}`), "working", "Retrying", item.sequence);
      else this.#invalidateBaselineActivity(session.id, hash(`${session.binding}:retry:${failure.id}`));
      this.#cancelSuperseded(session.id);
      return;
    }
    if (failure && !failure.willRetry) {
      session.failed = true; session.retrying = false;
      const eventId = hash(`${session.binding}:error:${failure.id}`);
      if (ready) this.#recordActivity(session, eventId, "error", failure.title, item.sequence);
      else this.#invalidateBaselineActivity(session.id, eventId);
      this.#signal(session, hash(`${session.binding}:error:${failure.id}`), "error", failure.title, ready);
      return;
    }
    if (session.retrying && (item.harness === "codex" && typeof payload?.delta === "string" && payload.delta.length > 0 &&
        (!session.turn || payload.turnId === session.turn) && ["item/agentMessage/delta", "item/plan/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta"].includes(item.nativeType) ||
        item.harness === "copilot" && item.nativeType === "assistant.message")) {
      session.retrying = false; session.failed = false;
      if (ready) this.#recordActivity(session, hash(`${session.binding}:progress:${item.sequence}`), "working", "Working", item.sequence);
      else this.#invalidateBaselineActivity(session.id, hash(`${session.binding}:progress:${item.sequence}`));
    }
    if (item.harness === "codex" && item.nativeType === "turn/completed" && turn?.status === "completed" && typeof turn.id === "string") {
      const eventId = hash(`${session.binding}:completion:${turn.id}`);
      session.failed = false; session.retrying = false;
      if (ready) this.#recordActivity(session, eventId, "completion", "Finished", item.sequence);
      else this.#invalidateBaselineActivity(session.id, eventId);
      this.#signal(session, eventId, "completion", "Finished working", ready);
    }
    if (item.harness === "codex" && item.nativeType === "turn/completed" && turn?.status === "interrupted") {
      if (ready) this.#recordActivity(session, hash(`${session.binding}:interrupted:${turn.id}`), "interrupted", "Interrupted", item.sequence);
      else this.#invalidateBaselineActivity(session.id, hash(`${session.binding}:interrupted:${turn.id}`));
      this.#cancelSuperseded(session.id);
    }
    if (item.harness === "copilot" && item.nativeType === "session.idle" && !session.turn && data?.aborted !== true && this.#activityFor(session.id)?.kind === "working") {
      this.#forgetActivity(session.id);
    }
    if (item.harness === "copilot" && item.nativeType === "session.idle" && (session.turn || data?.aborted === true)) {
      if (data?.aborted === true) {
        if (ready) this.#recordActivity(session, hash(`${session.binding}:interrupted:${session.turn ?? string(payload?.id) ?? item.sequence}`), "interrupted", "Interrupted", item.sequence);
        else this.#invalidateBaselineActivity(session.id, hash(`${session.binding}:interrupted:${session.turn ?? string(payload?.id) ?? item.sequence}`));
        this.#cancelSuperseded(session.id);
      } else if (!session.failed) {
        const eventId = hash(`${session.binding}:completion:${session.turn}`);
        if (ready) this.#recordActivity(session, eventId, "completion", "Finished", item.sequence);
        else this.#invalidateBaselineActivity(session.id, eventId);
        this.#signal(session, eventId, "completion", "Finished working", ready);
      }
      session.turn = undefined; session.retrying = false;
    }
  }

  flush(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#flushing ??= this.#flush().catch(() => { this.#lastError = "Notification delivery is temporarily unavailable"; }).finally(() => { this.#flushing = undefined; });
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#flushing;
    this.#sessions.clear(); this.#ready.clear(); this.#watched.clear(); this.#db.close();
  }
  async #flush(): Promise<void> {
    this.#prune();
    // Only four rows may hold subscription keys in an active batch. A single
    // slow device cannot block source ingestion or allocate an unbounded queue.
    const rows = this.#db.prepare("SELECT * FROM mobile_delivery WHERE next_at<=? ORDER BY id LIMIT 4").all(this.#now()) as unknown as DeliveryRow[];
    await Promise.all(rows.map(async (row) => {
      const device = this.#db.prepare("SELECT * FROM mobile_devices WHERE id=?").get(row.device_id) as unknown as DeviceRow | undefined;
      const payload = JSON.parse(row.payload) as MobileNotification;
      if (!device || !device.enabled || payload.kind !== "test" && (!(JSON.parse(device.categories) as MobileDevice["categories"])[payload.kind] || !this.#watched.has(payload.sessionId!))) {
        this.#db.prepare("DELETE FROM mobile_delivery WHERE id=?").run(row.id); return;
      }
      try {
        await this.#sender(JSON.parse(device.subscription) as MobileDeviceInput["subscription"], row.payload, Math.max(1, Math.floor((row.expires_at - this.#now()) / 1_000)), hash(payload.tag).slice(0, 32));
        this.#db.prepare("DELETE FROM mobile_delivery WHERE id=?").run(row.id);
        this.#lastError = undefined;
      } catch (error) {
        const status = object(error)?.statusCode;
        if (status === 404 || status === 410) { this.deleteDevice(row.device_id); return; }
        this.#lastError = "A notification could not be delivered";
        const retry = typeof status !== "number" || status === 429 || status >= 500;
        if (!retry || row.attempts + 1 >= MOBILE_LIMITS.attempts) this.#db.prepare("DELETE FROM mobile_delivery WHERE id=?").run(row.id);
        else this.#db.prepare("UPDATE mobile_delivery SET attempts=attempts+1,next_at=? WHERE id=?").run(this.#now() + Math.min(300_000, 5_000 * 2 ** row.attempts), row.id);
      }
    }));
  }
  #remember(session: SessionRecord, sourceId?: SourceId): void {
    const prior = this.#sessions.get(session.sessionId);
    const binding = hash(JSON.stringify([session.sessionId, session.runtimeNodeId, session.adapterScopeId, session.harness, session.vendorSessionId, session.bindingRevision, session.runtimeEpoch]));
    const title = string(session.metadata.values["agent.title"]) ?? string(object(session.nativeSummary)?.title) ?? string(object(session.nativeSummary)?.name);
    const stored = this.#db.prepare("SELECT binding,payload,native_sequence,turn_id FROM mobile_activity WHERE session_id=?").get(session.sessionId);
    const observation = stored ? JSON.parse(String(stored.payload)) as SessionActivity : undefined;
    if (observation && (!activityMatchesSession(observation, session) || session.catalogState === "archived")) this.#forgetActivity(session.sessionId);
    const restorable = stored?.binding === binding && observation && session.catalogState !== "archived";
    const remembered: ThinSession = { ...(prior?.binding === binding ? prior : restorable ? {
      sequence: stored.native_sequence == null ? undefined : Number(stored.native_sequence),
      turn: stored.turn_id == null || session.harness === "copilot" && (observation.kind === "completion" || observation.kind === "interrupted") ? undefined : String(stored.turn_id), failed: observation.kind === "error",
    } : {}), id: session.sessionId, sessionId: session.sessionId, runtimeNodeId: session.runtimeNodeId,
      adapterScopeId: session.adapterScopeId, vendorSessionId: session.vendorSessionId, bindingRevision: session.bindingRevision, runtimeEpoch: session.runtimeEpoch,
      sourceId: sourceId ?? prior?.sourceId ?? "" as SourceId, binding, epoch: session.runtimeEpoch, harness: session.harness,
      vendorId: session.vendorSessionId, title: bounded(title ?? `${session.harness} agent`, 160), runtimeStatus: session.runtimeStatus };
    this.#sessions.set(session.sessionId, remembered);
    // Catalog idle never proves success. Positive new work may invalidate an old
    // terminal observation after a missed start, but does not manufacture one.
    if (restorable && (!prior || prior.runtimeStatus !== "running") && session.runtimeStatus === "running" && observation.kind !== "working") {
      this.#forgetActivity(session.sessionId); remembered.failed = false; remembered.retrying = false; remembered.turn = undefined;
    }
    if (restorable && observation.kind === "working" && prior?.runtimeStatus === "running" && session.runtimeStatus !== "running") {
      this.#forgetActivity(session.sessionId);
    }
    while (this.#sessions.size > MOBILE_LIMITS.watches + SESSION_ACTIVITY_LIMIT) {
      const oldest = [...this.#sessions.keys()].find(id => !this.#watched.has(id));
      if (!oldest) break;
      this.#sessions.delete(oldest);
    }
  }
  #activityFor(sessionId: string): SessionActivity | undefined {
    const row = this.#db.prepare("SELECT payload FROM mobile_activity WHERE session_id=?").get(sessionId);
    return row ? JSON.parse(String(row.payload)) as SessionActivity : undefined;
  }
  #recordActivity(session: ThinSession, eventId: string, kind: SessionActivityKind, label: string, sequence?: number): void {
    const previous = this.#activityFor(session.id);
    if (previous?.eventId === eventId && previous.kind === kind) return;
    const now = this.#now();
    const payload: SessionActivity = { sessionId: session.sessionId, runtimeNodeId: session.runtimeNodeId, adapterScopeId: session.adapterScopeId,
      vendorSessionId: session.vendorSessionId, bindingRevision: session.bindingRevision, runtimeEpoch: session.runtimeEpoch, harness: session.harness,
      eventId, kind, label, occurredAt: new Date(now).toISOString() };
    this.#db.prepare(`INSERT INTO mobile_activity VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET binding=excluded.binding,payload=excluded.payload,observed_at=excluded.observed_at,native_sequence=excluded.native_sequence,turn_id=excluded.turn_id`)
      .run(session.id, session.binding, JSON.stringify(payload), now, sequence ?? session.sequence ?? null, session.turn ?? null);
    this.#db.prepare("DELETE FROM mobile_activity WHERE session_id IN (SELECT session_id FROM mobile_activity ORDER BY observed_at DESC,rowid DESC LIMIT -1 OFFSET ?)").run(SESSION_ACTIVITY_LIMIT);
    // Pending push is a current attention hint: never deliver an obsolete turn
    // after another event has already superseded it on this session.
    this.#db.prepare("DELETE FROM mobile_delivery WHERE session_id=? AND event_id<>?").run(session.id, eventId);
  }
  #forgetActivity(sessionId: string, cancelDelivery = true): void {
    this.#db.prepare("DELETE FROM mobile_activity WHERE session_id=?").run(sessionId);
    if (cancelDelivery) this.#cancelSuperseded(sessionId);
  }
  #cancelSuperseded(sessionId: string): void {
    this.#db.prepare("DELETE FROM mobile_delivery WHERE session_id=?").run(sessionId);
  }
  #interactionId(session: ThinSession, interaction: InteractionRecord): string {
    return hash(`${session.binding}:input:${interaction.interactionId}`);
  }
  #blockingRootInteraction(session: ThinSession, interaction: InteractionRecord): boolean {
    const json = object(interaction.payload.json);
    const params = object(json?.params) ?? json;
    return params?.isBlocking !== false && !(typeof params?.threadId === "string" && params.threadId !== session.vendorId) && typeof json?.agentId !== "string";
  }
  #invalidateBaselineActivity(sessionId: string, eventId: string): void {
    // Baseline replay may retire old observations, but never creates a new
    // Finished/unread marker or a push notification for historical work.
    const activity = this.#activityFor(sessionId);
    if (activity && activity.eventId !== eventId) this.#forgetActivity(sessionId);
  }
  #signal(session: ThinSession, eventId: string, kind: Exclude<MobileKind, "test">, body: string, ready: boolean): void {
    if (!this.#watched.has(session.id) || this.#seen(eventId) || !ready) return;
    const devices = (this.#db.prepare("SELECT * FROM mobile_devices WHERE enabled=1").all() as unknown as DeviceRow[])
      .filter((device) => (JSON.parse(device.categories) as MobileDevice["categories"])[kind]);
    this.#queue({ eventId, title: session.title, body, sessionId: session.id, kind }, devices);
  }
  #seen(eventId: string): boolean {
    this.#prune();
    const result = this.#db.prepare("INSERT OR IGNORE INTO mobile_dedupe VALUES(?,?)").run(eventId, this.#now());
    if (result.changes !== 0 && ++this.#dedupeCount > MOBILE_LIMITS.dedupeRecords) {
      this.#db.prepare("DELETE FROM mobile_dedupe WHERE event_id=(SELECT event_id FROM mobile_dedupe ORDER BY created_at,rowid LIMIT 1)").run();
      this.#dedupeCount -= 1;
    }
    return result.changes === 0;
  }
  #queue(signal: Pick<MobileNotification, "eventId" | "title" | "body" | "sessionId" | "kind">, devices: DeviceRow[]): void {
    this.#prune();
    const now = this.#now();
    const expires = now + (signal.kind === "completion" || signal.kind === "test" ? 3_600_000 : 86_400_000);
    const payload: MobileNotification = { version: 1, ...signal, tag: signal.sessionId ? `leo-session-${hash(signal.sessionId)}` : `leo-${signal.eventId}`,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString() };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > MOBILE_LIMITS.payloadBytes) throw new TypeError("Notification exceeds payload limit");
    for (const device of devices) {
      if (this.#count("mobile_delivery") >= MOBILE_LIMITS.pending) {
        // Bounded delivery is explicitly best effort. Preserve recent attention
        // rather than allowing a disconnected phone to pin every old turn.
        this.#db.prepare("DELETE FROM mobile_delivery WHERE id=(SELECT id FROM mobile_delivery ORDER BY id LIMIT 1)").run();
        this.#lastError = "Older notifications expired from the delivery queue";
      }
      this.#db.prepare("INSERT OR IGNORE INTO mobile_delivery(device_id,event_id,session_id,payload,expires_at,next_at) VALUES(?,?,?,?,?,?)")
        .run(device.id, signal.eventId, signal.sessionId, serialized, expires, now);
    }
  }
  #prune(): void {
    const now = this.#now();
    this.#db.prepare("DELETE FROM mobile_delivery WHERE expires_at<=?").run(now);
    if (now - this.#lastPrune < 60_000 && this.#lastPrune !== 0) return;
    this.#lastPrune = now;
    this.#db.prepare("DELETE FROM mobile_dedupe WHERE created_at<?").run(now - MOBILE_LIMITS.dedupeMs);
    this.#db.prepare("DELETE FROM mobile_dedupe WHERE event_id IN (SELECT event_id FROM mobile_dedupe ORDER BY created_at DESC LIMIT -1 OFFSET ?)").run(MOBILE_LIMITS.dedupeRecords);
    this.#dedupeCount = Number(this.#db.prepare("SELECT count(*) AS count FROM mobile_dedupe").get()!.count);
  }
  #count(table: "mobile_devices" | "mobile_delivery"): number { return Number(this.#db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count); }
}
function publicDevice(row: DeviceRow): MobileDevice {
  return { id: row.id, name: row.name, enabled: Boolean(row.enabled), categories: JSON.parse(row.categories) as MobileDevice["categories"],
    createdAt: new Date(row.created_at).toISOString(), lastSeenAt: new Date(row.last_seen_at).toISOString() };
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function bounded(value: string, bytes: number): string { return new TextDecoder().decode(Buffer.from(value.replaceAll(/[\u0000-\u001f\u007f]/g, " ")).subarray(0, bytes), { stream: true }); }
function hash(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
