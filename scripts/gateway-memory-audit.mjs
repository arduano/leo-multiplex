// Disposable gateway memory audit. Uses the published projection and the real
// personal HTTP surface, with an in-process synthetic control source. No P2P,
// native provider, production credentials, catalog writes or model calls.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { createPersonalHttpSurface } from "../dist/apps/server/src/http.js";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const timestamp = "2026-09-06T00:00:00.000Z";
const sessionId = id(4);
const authority = { realmId: id(1), controlNodeId: id(2), epochId: id(3) };
const runtimeEpoch = id(6);
const totalItems = 100_000;

function fixtureSnapshot() {
  const manifest = { componentKind: "control-node", protocolVersion: 5, sourceControlNodeId: id(2), sourceControlNodeBootId: id(7), authority, projectionRootControlNodeId: id(2), coveredControlNodeIds: [id(2)], feedId: id(8), controlCursor: 0, generatedAt: timestamp, capabilities: [] };
  return {
    manifest, parentByControlNodeId: { [id(2)]: null },
    controlNodes: [{ controlNodeId: id(2), controlNodeBootId: id(7), feedId: id(8), name: "Fixture control", presence: "online", dataRole: { role: "authority", authority }, connectedAt: timestamp, lastHeartbeatAt: timestamp, protocolVersion: 5, capabilities: [] }],
    runtimeNodes: [{ runtimeNodeId: id(5), runtimeNodeBootId: runtimeEpoch, ownerControlNodeId: id(2), name: "Fixture runtime", presence: "online", reachability: "reachable", connectedAt: timestamp, lastHeartbeatAt: timestamp, allowedRoots: ["/work"], harnesses: [], launchProfiles: [], protocolVersion: 5 }],
    sessions: [{ sessionId, runtimeNodeId: id(5), harness: "codex", adapterScopeId: "fixture", vendorSessionId: "fixture-native", bindingRevision: 1, runtimeEpoch, cwd: "/work", availability: "active", runtimeStatus: "idle", launchProvenance: null, metadata: { revision: 0, values: {}, keyRevisions: {} }, metadataAuthority: authority, catalogState: "open", catalogRevision: 1, archivedAt: null, createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, lastActivityAt: timestamp }],
    interactions: [], metadataOperations: [],
  };
}

if (process.argv.includes("--worker")) {
  assert(global.gc, "Run the audit worker with --expose-gc");
  const snapshot = fixtureSnapshot();
  let historyBytes = 0;
  let historyPages = 0;
  const source = { sourceId: "fixture", displayName: "Fixture", endpointId: "fixture", client: {
    loadSnapshot: async () => snapshot,
    readNativeHistory: async (_session, request) => {
      const offset = Number(request.cursor ?? 0);
      const data = Array.from({ length: Math.min(100, totalItems - offset) }, (_, index) => {
        const item = offset + index;
        return { turnId: `turn-${Math.floor(item / 2)}`, item: { type: "agentMessage", id: `item-${item}`, phase: "final_answer", text: `${item}: ${"Disposable history content. ".repeat(76)}` } };
      });
      const nextCursor = offset + 100 < totalItems ? String(offset + 100) : null;
      const result = { harness: "codex", vendorSessionId: "fixture-native", complete: nextCursor === null, ...(nextCursor ? { nextCursor } : {}), payload: { encoding: "native-json-images-v1", images: [], json: { data, nextCursor } } };
      historyBytes += Buffer.byteLength(JSON.stringify(result)); historyPages++;
      return result;
    },
  } };
  const projection = new AccessGatewayProjection([source]);
  await projection.refreshAll();
  const surface = createPersonalHttpSurface(projection, "fixture-gateway", { mode: "tailscale", publicOrigin: "http://100.64.0.2:8444", email: "owner@example.test" });
  surface.server.listen(0, "127.0.0.1"); await once(surface.server, "listening");
  let sequence = 0;
  let observer;
  function ingest(count, bytes) {
    for (let index = 0; index < count; index++) {
      // Allocate independent strings, as native transport decoding does.
      const delta = `${++sequence}:` + Buffer.alloc(bytes, 97 + sequence % 26).toString();
      assert(projection.ingest("fixture", { kind: "native", sessionId, harness: "codex", runtimeEpoch, sequence,
        nativeType: "item/agentMessage/delta", ephemeral: false,
        provenance: { originControlNodeId: id(2), authority },
        payload: { encoding: "native-json-images-v1", images: [], json: { threadId: "fixture-native", turnId: "fixture-turn", itemId: "fixture-item", delta } },
      }));
    }
  }
  process.on("message", async message => {
    try {
      if (message.command === "ingest") ingest(message.count, message.bytes);
      if (message.command === "attachSlow") observer = projection.attach({ sessions: [sessionId], includeNative: true })[Symbol.asyncIterator]();
      if (message.command === "consumeReplay") {
        observer = projection.attach({ sessions: [sessionId], includeNative: true,
          cursor: { feedId: projection.feedId(), controlCursor: 0, native: { [sessionId]: { runtimeEpoch, sequence: sequence - 4_096 } } },
        })[Symbol.asyncIterator]();
        for (;;) { const item = await observer.next(); if (item.value?.kind === "heartbeat") break; }
      }
      if (message.command === "closeSlow") { await observer?.return(); observer = undefined; }
      if (message.command === "reset") { projection.markUnavailable("fixture"); await projection.refreshAll(); }
      if (message.command === "close") { await surface.close(); process.disconnect(); return; }
      const beforeGc = process.memoryUsage();
      global.gc(); await new Promise(resolve => setImmediate(resolve)); global.gc();
      process.send({ id: message.id, beforeGc, retained: process.memoryUsage(), historyBytes, historyPages });
    } catch (error) { process.send({ id: message.id, error: String(error) }); }
  });
  process.send({ ready: true, port: surface.server.address().port });
} else {
  const output = resolve("receipts/gateway-memory", new Date().toISOString().replaceAll(":", "-"));
  await mkdir(output, { recursive: true });
  const worker = fork(import.meta.filename, ["--worker"], { execArgv: ["--expose-gc"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const [ready] = await once(worker, "message");
  assert(ready.ready);
  let operation = 0;
  const samples = [];
  async function sample(stage, command = "sample", extra = {}) {
    const id = ++operation;
    const reply = once(worker, "message"); worker.send({ id, command, ...extra });
    const [result] = await reply; assert.equal(result.id, id); assert(!result.error, result.error);
    samples.push({ stage, ...result });
  }
  async function page(offset) {
    const input = { sessionId, request: { harness: "codex", includeTurns: true, limit: 100, cursor: String(offset) } };
    const response = await fetch(`http://127.0.0.1:${ready.port}/trpc/sessions.readNativeHistory?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { "Tailscale-User-Login": "owner@example.test" }, signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200);
    // Keep fixture/client allocations outside the measured gateway process.
    await response.arrayBuffer();
  }
  try {
    await sample("idle gateway");
    for (let offset = 0; offset < totalItems; offset += 100) {
      await page(offset);
      if ([1_000, 10_000, 100_000].includes(offset + 100)) await sample(`${offset + 100} history items forwarded`);
    }
    await Promise.all(Array.from({ length: 4 }, async () => { for (let offset = 0; offset < 10_000; offset += 100) await page(offset); }));
    await sample("four concurrent readers, 40,000 additional items");
    await sample("4096 retained 16 KiB live events", "ingest", { count: 4_096, bytes: 16_384 });
    await sample("8192 total 16 KiB live events, journal remains 4096", "ingest", { count: 4_096, bytes: 16_384 });
    await sample("4096 retained 64 KiB live events", "ingest", { count: 4_096, bytes: 65_536 });
    await sample("journal cleared by source reset", "reset");
    await sample("slow observer attached", "attachSlow");
    await sample("8192 queued 16 KiB events for stalled observer", "ingest", { count: 8_192, bytes: 16_384 });
    await sample("stalled observer exceeds item cap", "ingest", { count: 1, bytes: 16_384 });
    await sample("observer closed, journal still retained", "closeSlow");
    await sample("final idle after source reset", "reset");
    await sample("replay fixture: 4096 retained 16 KiB events", "ingest", { count: 4_096, bytes: 16_384 });
    await sample("resumed subscriber consumed the replay", "consumeReplay");
    await sample("journal reset while consumed replay subscriber remains", "reset");
    await sample("consumed replay subscriber released", "closeSlow");
    const hash = data => createHash("sha256").update(data).digest("hex");
    const inputs = [import.meta.filename, "package-lock.json", "apps/server/src/http.ts", "apps/server/src/gateway.ts", "apps/web/src/websocket-egress.ts"];
    const hashes = Object.fromEntries(await Promise.all(inputs.map(async path => [path, hash(await readFile(path))])));
    const manifest = { status: "passed", fixtureTurns: 50_000, fixtureItems: totalItems, process: process.version,
      scope: "Published projection and personal HTTP gateway in an isolated child process; synthetic control source, no P2P/native provider", modelCalls: 0, samples, hashes };
    await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(join(output, "SHA256SUMS"), hash(await readFile(join(output, "manifest.json"))) + "  manifest.json\n");
    console.log(JSON.stringify({ output, samples }, null, 2));
  } finally {
    worker.send({ command: "close" });
    await once(worker, "exit");
  }
}
