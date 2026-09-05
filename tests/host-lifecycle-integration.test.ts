import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockAgentAdapter } from "@arduano/agent-multiplex-adapter-mock";
import { archiveRequest, launchRequest, resumeCommand, sessionCommand, stopCommand } from "@arduano/agent-multiplex-client";
import { ControlNodeCatalog, ControlNodeService } from "@arduano/agent-multiplex-control-node-core";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { newRuntimeNodeBootId, newRuntimeNodeId, sessionSearchInputSchema, sourceIdSchema } from "@arduano/agent-multiplex-protocol";
import { RuntimeNodeService, RuntimeNodeStore, runtimeBackendForAdapter } from "@arduano/agent-multiplex-runtime-node-core";
import { afterEach, expect, it, vi } from "vitest";

import { LeoWorkspaceLaunchProvider } from "../packages/launch/src/index.js";
import { controlSource, runtimeConnection } from "./helpers/in-process-roles.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it("routes the personal lifecycle through gateway/control/runtime while main-pc retains canonical authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "leo-cross-role-test-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "keep.txt"), "caller-owned workspace");
  const catalogFile = join(directory, "main-pc-control.sqlite");
  const catalog = new ControlNodeCatalog({ filename: catalogFile, controlNodeName: "main-pc" });
  const control = new ControlNodeService({ catalog });
  const runtimeStore = new RuntimeNodeStore(join(directory, "main-pc-runtime.sqlite"));
  const adapter = new MockAgentAdapter({ streamIntervalMs: 0, chunkCount: 1 });
  const spawn = vi.spyOn(adapter, "spawn");
  const resume = vi.spyOn(adapter, "resume");
  const close = vi.spyOn(adapter, "close");
  const releases: string[] = [];
  const backend = { ...runtimeBackendForAdapter(adapter), releaseSession: vi.fn(async () => { releases.push("backend"); }) };
  const provider = new LeoWorkspaceLaunchProvider(backend, { model: "mock-model", effort: "high" });
  const release = vi.spyOn(provider, "release").mockImplementation(async () => { releases.push("provider"); });
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodeBootId = newRuntimeNodeBootId();
  const runtime = new RuntimeNodeService({
    store: runtimeStore, runtimeNodeId, runtimeNodeBootId, name: "main-pc",
    allowedRoots: ["/"], backends: [backend], launchProviders: [provider], includeDirectWorkspaceProvider: false,
  });
  const connection = runtimeConnection(runtime, runtimeNodeId, runtimeNodeBootId);
  const ingress = { authenticatedRuntimeNodeId: runtimeNodeId, endpointId: connection.endpointId, runtimeNodeConnection: connection };
  const source = controlSource(control);
  const sourceId = sourceIdSchema.parse("main-pc");
  const gateway = new AccessGatewayProjection([{ sourceId, displayName: "main-pc", endpointId: "fixture-control-endpoint", client: source }]);
  const controller = new AbortController();
  let pump: Promise<void> | undefined;
  let pumpFailure: unknown;
  let archivedSessionId: Parameters<ControlNodeCatalog["getSession"]>[0] | undefined;
  const authority = catalog.authority();

  try {
    control.registerRuntimeNode(await runtime.describe(), ingress);
    // The same authenticated reverse-feed boundary used by the transport pump.
    pump = (async () => {
      for await (const event of runtime.events({ native: {} }, controller.signal)) {
        const result = control.publishRuntimeEvent({ runtimeNodeId, runtimeNodeBootId, event }, ingress);
        if (!result.accepted) throw new Error("Fixture event was not accepted by its authority");
      }
    })().catch((error: unknown) => { pumpFailure = error; });
    await gateway.refreshSource(sourceId);
    const profiles = await gateway.listLaunchProfiles({ runtimeNodeId, harness: "codex" });
    expect(profiles.map(({ providerId, profileId }) => ({ providerId, profileId }))).toEqual([{ providerId: "leo.local", profileId: "workspace" }]);
    expect(await gateway.listLaunchModels(runtimeNodeId, provider.descriptor, "codex")).toEqual(await adapter.listModels());

    const { providerId, profileId, contractVersion, requestSchemaHash } = provider.descriptor;
    const request = launchRequest(runtimeNodeId, { providerId, profileId, contractVersion, requestSchemaHash }, "codex", { cwd: workspace, mode: "plan" }, { "agent.title": "Disposable integration session" });
    archivedSessionId = request.sessionId;
    await expect(gateway.createLaunch(request)).resolves.toMatchObject({ launchId: request.launchId });
    await vi.waitFor(async () => { expect((await gateway.getLaunch(request.launchId))?.state).toBe("succeeded"); });
    await vi.waitFor(() => { expect(catalog.getSession(request.sessionId)?.launchProvenance?.providerId).toBe("leo.local"); });
    await gateway.createLaunch(request);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      cwd: workspace, approvalPolicy: "never", sandbox: "danger-full-access",
      collaborationMode: { mode: "plan", settings: { model: "mock-model", reasoning_effort: "high", developer_instructions: null } },
    });

    const initial = catalog.getSession(request.sessionId)!;
    expect(initial.metadataAuthority).toEqual(authority);
    expect(initial.metadata.values).toEqual({});
    runtime.applyCanonicalSessions([initial]);
    const proposals = runtime.metadataOutbox();
    expect(proposals).toHaveLength(1);
    runtime.settleMetadataOutbox(await control.pushRuntimeMetadataOutbox({ runtimeNodeId, runtimeNodeBootId, patches: proposals }, ingress));
    await gateway.refreshSource(sourceId);
    const active = (await gateway.getSession(request.sessionId))!;
    expect(active.metadata.values["agent.title"]).toBe("Disposable integration session");
    expect(active.metadata.revision).toBeGreaterThan(initial.metadata.revision);
    expect(active.metadataAuthority).toEqual(authority);
    expect(runtimeStore.getSession(request.sessionId)?.vendorSessionId).toBe(active.vendorSessionId);

    // An active binding cannot be archived; no resource release has run.
    await expect(gateway.archive(archiveRequest(active))).rejects.toThrow("stop the session");
    expect(releases).toEqual([]);
    const stoppedCommand = stopCommand(active);
    await expect(gateway.stop(stoppedCommand)).resolves.toMatchObject({ state: "succeeded" });
    await vi.waitFor(() => { expect(catalog.getSession(request.sessionId)?.runtimeStatus).toBe("stopped"); });
    await gateway.refreshSource(sourceId);
    const stopped = (await gateway.getSession(request.sessionId))!;
    expect(stopped.catalogState).toBe("open");
    expect((await gateway.searchSessions(sessionSearchInputSchema.parse({}))).sessions.map((session) => session.sessionId)).toContain(request.sessionId);
    expect(release).not.toHaveBeenCalled();
    expect((await adapter.listSessions())[0]?.availability).toBe("resumable");
    expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe("caller-owned workspace");

    // Losing the gateway source cannot promote it or dispatch a stale mutation.
    gateway.markUnavailable(sourceId, new Error("fixture source outage"));
    await expect(async () => gateway.resume(resumeCommand(stopped))).rejects.toThrow();
    expect(resume).not.toHaveBeenCalled();
    expect(catalog.authority()).toEqual(authority);
    expect(catalog.getSession(request.sessionId)?.runtimeStatus).toBe("stopped");
    await gateway.refreshSource(sourceId);
    const resumeRequest = resumeCommand(stopped);
    await expect(gateway.resume(resumeRequest)).resolves.toMatchObject({ state: "succeeded" });
    await gateway.resume(resumeRequest);
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0]).toMatchObject({ vendorSessionId: active.vendorSessionId, cwd: workspace, approvalPolicy: "never", sandbox: "danger-full-access" });
    await vi.waitFor(() => { expect(catalog.getSession(request.sessionId)?.availability).toBe("active"); });
    await gateway.refreshSource(sourceId);
    const resumed = (await gateway.getSession(request.sessionId))!;
    expect(resumed.vendorSessionId).toBe(active.vendorSessionId);
    expect(resumed.runtimeEpoch).not.toBe(active.runtimeEpoch);
    const send = sessionCommand(resumed, { harness: "codex", command: { type: "send", input: "Disposable mock prompt" } });
    await expect(gateway.execute(send)).resolves.toMatchObject({ state: "succeeded" });
    await vi.waitFor(() => { expect(runtimeStore.getSession(request.sessionId)?.runtimeStatus).toBe("idle"); });

    await gateway.stop(stopCommand(resumed));
    await gateway.refreshSource(sourceId);
    const archive = archiveRequest((await gateway.getSession(request.sessionId))!);
    await gateway.archive(archive);
    await vi.waitFor(async () => { expect((await gateway.getArchive(archive.archiveOperationId))?.state).toBe("succeeded"); });
    await gateway.refreshSource(sourceId);
    expect(releases).toEqual(["backend", "provider"]);
    expect(close).not.toHaveBeenCalled();
    expect((await gateway.searchSessions(sessionSearchInputSchema.parse({}))).sessions).toEqual([]);
    const cold = await gateway.searchSessions(sessionSearchInputSchema.parse({ states: ["archived"] }));
    expect(cold.sessions).toHaveLength(1);
    expect(cold.sessions[0]).toMatchObject({ sessionId: request.sessionId, catalogState: "archived", metadataAuthority: authority });
    expect(cold.sessions[0]?.metadata.values["agent.title"]).toBe("Disposable integration session");
    expect((await runtime.refreshInventory()).sessions).toEqual([]);
    expect(await readFile(join(workspace, "keep.txt"), "utf8")).toBe("caller-owned workspace");
    await expect(async () => gateway.resume(resumeCommand(cold.sessions[0]!))).rejects.toThrow();
    expect(pumpFailure).toBeUndefined();
  } finally {
    controller.abort();
    await pump;
    try { await runtime.close(); } finally { runtimeStore.close(); control.close(); catalog.close(); }
  }

  try {
    const reopened = new ControlNodeCatalog({ filename: catalogFile, controlNodeName: "main-pc" });
    try {
      expect(reopened.authority()).toEqual(authority);
      expect(reopened.getSession(archivedSessionId!)?.catalogState).toBe("archived");
      expect(reopened.getSession(archivedSessionId!)?.metadata.values["agent.title"]).toBe("Disposable integration session");
      expect(new AccessGatewayProjection([]).listSessions()).toEqual([]);
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
