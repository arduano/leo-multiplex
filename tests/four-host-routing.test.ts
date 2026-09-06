import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockAgentAdapter } from "@arduano/agent-multiplex-adapter-mock";
import { launchRequest, sessionCommand } from "@arduano/agent-multiplex-client";
import { ControlNodeCatalog, ControlNodeService } from "@arduano/agent-multiplex-control-node-core";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { newRuntimeNodeBootId, newRuntimeNodeId, sourceIdSchema, type SessionRecord } from "@arduano/agent-multiplex-protocol";
import { RuntimeNodeService, RuntimeNodeStore, runtimeBackendForAdapter } from "@arduano/agent-multiplex-runtime-node-core";
import { expect, it, vi } from "vitest";

import { readSessionCatalog } from "../apps/web/src/client/session-catalog.js";
import { LeoWorkspaceLaunchProvider } from "../packages/launch/src/index.js";
import { controlSource, runtimeConnection } from "./helpers/in-process-roles.js";

async function createHost(directory: string, name: string) {
  const workspace = join(directory, name);
  await mkdir(workspace);
  const catalog = new ControlNodeCatalog({ filename: join(directory, `${name}-control.sqlite`), controlNodeName: name });
  const control = new ControlNodeService({ catalog });
  const store = new RuntimeNodeStore(join(directory, `${name}-runtime.sqlite`));
  const adapter = new MockAgentAdapter({ streamIntervalMs: 0, chunkCount: 1 });
  const modelId = `mock-model-${name}`;
  const models = vi.spyOn(adapter, "listModels").mockResolvedValue([
    { harness: "codex", id: modelId, name: `Mock model on ${name}`, native: { mock: true } },
  ]);
  const spawn = vi.spyOn(adapter, "spawn");
  const backend = runtimeBackendForAdapter(adapter);
  const provider = new LeoWorkspaceLaunchProvider(backend, { model: modelId, effort: "high" });
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodeBootId = newRuntimeNodeBootId();
  const runtime = new RuntimeNodeService({
    store, runtimeNodeId, runtimeNodeBootId, name,
    allowedRoots: [workspace], backends: [backend], launchProviders: [provider], includeDirectWorkspaceProvider: false,
  });
  const connection = runtimeConnection(runtime, runtimeNodeId, runtimeNodeBootId);
  const ingress = { authenticatedRuntimeNodeId: runtimeNodeId, endpointId: connection.endpointId, runtimeNodeConnection: connection };
  const source = controlSource(control);
  const search = vi.spyOn(source, "searchSessions");
  const execute = vi.spyOn(connection, "execute");
  const history = vi.spyOn(connection, "readNativeHistory");
  const sourceId = sourceIdSchema.parse(name);
  const controller = new AbortController();
  const pumpFailures: unknown[] = [];
  control.registerRuntimeNode(await runtime.describe(), ingress);
  const pump = (async () => {
    for await (const event of runtime.events({ native: {} }, controller.signal)) {
      const result = control.publishRuntimeEvent({ runtimeNodeId, runtimeNodeBootId, event }, ingress);
      if (!result.accepted) throw new Error(`Runtime event rejected on ${name}`);
    }
  })().catch((error: unknown) => { pumpFailures.push(error); });

  return {
    name, workspace, catalog, control, runtimeNodeId, provider, modelId,
    models, spawn, search, execute, history, sourceId, source, pumpFailures,
    async close() {
      controller.abort();
      await pump;
      try { await runtime.close(); } finally { store.close(); control.close(); catalog.close(); }
    },
  };
}

it("keeps four independent hosts visible and routes each model, launch, command and history to its owner through a source outage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "leo-four-host-routing-"));
  const hosts: Awaited<ReturnType<typeof createHost>>[] = [];
  try {
    for (const name of ["main-pc", "home-nas", "work-laptop", "fourth-host"]) {
      hosts.push(await createHost(directory, name));
    }
    const gateway = new AccessGatewayProjection(hosts.map((host) => ({
      sourceId: host.sourceId, displayName: host.name,
      endpointId: `fixture-${host.name}-control-endpoint`, client: host.source,
    })));
    for (const host of hosts) await gateway.refreshSource(host.sourceId);
    expect(gateway.listRuntimeNodes().map(({ runtimeNodeId }) => runtimeNodeId).sort())
      .toEqual(hosts.map(({ runtimeNodeId }) => runtimeNodeId).sort());

    const sessions: SessionRecord[] = [];
    for (const host of hosts) {
      const previousModelCalls = hosts.map(({ models }) => models.mock.calls.length);
      const profiles = await gateway.listLaunchProfiles({ runtimeNodeId: host.runtimeNodeId, harness: "codex" });
      expect(profiles).toHaveLength(1);
      expect((await gateway.listLaunchModels(host.runtimeNodeId, profiles[0]!, "codex")).map(({ id }) => id)).toEqual([host.modelId]);
      hosts.forEach((candidate, i) => expect(candidate.models).toHaveBeenCalledTimes(previousModelCalls[i]! + (candidate === host ? 1 : 0)));

      const previousSpawnCalls = hosts.map(({ spawn }) => spawn.mock.calls.length);
      const { providerId, profileId, contractVersion, requestSchemaHash } = profiles[0]!;
      const request = launchRequest(host.runtimeNodeId, { providerId, profileId, contractVersion, requestSchemaHash }, "codex", { cwd: host.workspace, model: host.modelId });
      await gateway.createLaunch(request);
      await vi.waitFor(async () => { expect((await gateway.getLaunch(request.launchId))?.state).toBe("succeeded"); });
      await vi.waitFor(() => { expect(host.catalog.getSession(request.sessionId)?.availability).toBe("active"); });
      await gateway.refreshSource(host.sourceId);
      const session = (await gateway.getSession(request.sessionId))!;
      expect(session).toMatchObject({ sessionId: request.sessionId, runtimeNodeId: host.runtimeNodeId, metadataAuthority: host.catalog.authority() });
      hosts.forEach((candidate, i) => {
        expect(candidate.spawn).toHaveBeenCalledTimes(previousSpawnCalls[i]! + (candidate === host ? 1 : 0));
        if (candidate !== host) expect(candidate.catalog.getSession(session.sessionId)).toBeNull();
      });
      expect(host.spawn.mock.calls[0]?.[0]).toMatchObject({ cwd: host.workspace, model: host.modelId });
      sessions.push(session);
    }

    // Native IDs deliberately collide across hosts. Only logical IDs and the
    // owning authority/runtime may determine routing or transcript selection.
    expect(new Set(sessions.map(({ vendorSessionId }) => vendorSessionId)).size).toBe(1);
    expect(new Set(sessions.map(({ sessionId }) => sessionId)).size).toBe(4);
    expect(new Set(sessions.map(({ metadataAuthority }) => JSON.stringify(metadataAuthority))).size).toBe(4);

    const readCatalog = () => readSessionCatalog((query) => gateway.searchSessions(query), new AbortController().signal);
    hosts.forEach(({ search }) => search.mockClear());
    const initial = await readCatalog();
    expect(initial.complete).toBe(true);
    expect(initial.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(sessions.map(({ sessionId }) => sessionId).sort());
    for (const host of hosts) {
      expect(host.search).toHaveBeenCalledOnce();
      expect(host.search.mock.calls[0]?.[0].limit).toBe(500);
      // Each source returns just one row despite the requested 500-row page.
      expect((await host.search.mock.results[0]!.value).sessions).toHaveLength(1);
    }

    async function sendAndRead(index: number, label: string) {
      const host = hosts[index]!;
      const session = sessions[index]!;
      const previousExecuteCalls = hosts.map(({ execute }) => execute.mock.calls.length);
      const previousHistoryCalls = hosts.map(({ history }) => history.mock.calls.length);
      const input = `${label} for ${host.name}`;
      await expect(gateway.execute(sessionCommand(session, { harness: "codex", command: { type: "send", input } }))).resolves.toMatchObject({ state: "succeeded" });
      await vi.waitFor(() => { expect(host.catalog.getSession(session.sessionId)?.runtimeStatus).toBe("idle"); });
      const history = await gateway.readNativeHistory(session.sessionId, { harness: "codex", includeTurns: true });
      expect(JSON.stringify(history.payload.json)).toContain(input);
      for (const other of hosts) {
        if (other !== host) expect(JSON.stringify(history.payload.json)).not.toContain(`for ${other.name}`);
      }
      hosts.forEach((candidate, i) => {
        expect(candidate.execute).toHaveBeenCalledTimes(previousExecuteCalls[i]! + (candidate === host ? 1 : 0));
        expect(candidate.history).toHaveBeenCalledTimes(previousHistoryCalls[i]! + (candidate === host ? 1 : 0));
      });
    }
    for (let index = 0; index < hosts.length; index++) await sendAndRead(index, "Initial mock prompt");

    const unavailable = hosts[1]!;
    gateway.markUnavailable(unavailable.sourceId, new Error("Disposable source outage"));
    const duringOutage = await readCatalog();
    expect(duringOutage.complete).toBe(true);
    expect(duringOutage.sessions.map(({ sessionId }) => sessionId).sort())
      .toEqual(sessions.filter((_, i) => i !== 1).map(({ sessionId }) => sessionId).sort());
    expect(unavailable.catalog.getSession(sessions[1]!.sessionId)?.metadataAuthority).toEqual(sessions[1]!.metadataAuthority);
    const unavailableExecuteCount = unavailable.execute.mock.calls.length;
    await expect(async () => gateway.execute(sessionCommand(sessions[1]!, { harness: "codex", command: { type: "send", input: "Must not dispatch" } }))).rejects.toThrow();
    expect(unavailable.execute).toHaveBeenCalledTimes(unavailableExecuteCount);
    for (const index of [0, 2, 3]) {
      const host = hosts[index]!;
      expect((await gateway.listLaunchModels(host.runtimeNodeId, host.provider.descriptor, "codex")).map(({ id }) => id)).toEqual([host.modelId]);
      await sendAndRead(index, "Mock prompt during another host outage");
    }

    await gateway.refreshSource(unavailable.sourceId);
    const reconnected = await readCatalog();
    expect(reconnected.complete).toBe(true);
    expect(reconnected.sessions).toHaveLength(4);
    for (const original of sessions) {
      expect(reconnected.sessions.find(({ sessionId }) => sessionId === original.sessionId)).toMatchObject({
        sessionId: original.sessionId, runtimeNodeId: original.runtimeNodeId,
        vendorSessionId: original.vendorSessionId, metadataAuthority: original.metadataAuthority,
      });
    }
    await sendAndRead(1, "Mock prompt after reconnect");
    // Windows and WSL on one laptop can disappear together and return in a
    // different order. Each source retains independent authority and routing.
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const index of [2, 3]) gateway.markUnavailable(hosts[index]!.sourceId, new Error("Disposable laptop sleep"));
      const asleep = await readCatalog();
      expect(asleep.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(sessions.slice(0, 2).map(({ sessionId }) => sessionId).sort());
      for (const index of [0, 1]) await sendAndRead(index, `Mock prompt during laptop sleep ${cycle}`);
      for (const index of [3, 2]) {
        await gateway.refreshSource(hosts[index]!.sourceId);
        const restored = await gateway.getSession(sessions[index]!.sessionId);
        expect(restored).toMatchObject({ sessionId: sessions[index]!.sessionId, metadataAuthority: sessions[index]!.metadataAuthority });
      }
      expect((await readCatalog()).sessions).toHaveLength(4);
    }
    for (const host of hosts) expect(host.pumpFailures).toEqual([]);
  } finally {
    try { await Promise.all(hosts.map((host) => host.close())); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});
