import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationContext } from "@arduano/p2prpc-core";
import { authorizeWorkHost, createWorkCommandHost, createWorkCommandsGateway, validateWorkHostPairings } from "../packages/work-commands/src/transport.js";
import type { WorkCommandExecutor, WorkCommandRecord, WorkCommandRequest } from "../packages/work-commands/src/contract.js";

const secret = "disposable-work-command-transport-fixture-secret";
const closes: Array<() => Promise<void>> = [];
const directories: string[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function state() { const path = await mkdtemp(join(tmpdir(), "leo-work-transport-")); directories.push(path); return path; }
async function port() {
  const socket = createSocket("udp4");
  await new Promise<void>(resolve => socket.bind(0, "0.0.0.0", resolve));
  const value = socket.address().port;
  await new Promise<void>(resolve => socket.close(resolve)); return value;
}
function executor(): WorkCommandExecutor & { submit: ReturnType<typeof vi.fn> } {
  const records = new Map<string, WorkCommandRecord>();
  return {
    submit: vi.fn(async (request: WorkCommandRequest) => {
      const existing = records.get(request.operationId); if (existing) return existing;
      const record: WorkCommandRecord = { ...request, payloadHash: "a".repeat(64), state: "completed", stdout: "fixture output", stderr: "",
        truncated: false, exitCode: 0, signal: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
      records.set(request.operationId, record); return record;
    }),
    get: async id => records.get(id) ?? null, cancel: async id => records.get(id) ?? null, close: async () => undefined,
  };
}
const request = () => ({ operationId: randomUUID(), cwd: "/fixture/work", command: "fixture command", timeoutMs: 1_000 });

describe("private work command transport", () => {
  it.skipIf(process.platform === "win32")("rejects broad identity directories and files before connecting", async () => {
    const stateDirectory = await state();
    const options = { stateDirectory, sharedSecret: secret, hosts: [] };
    await chmod(stateDirectory, 0o755);
    await expect(createWorkCommandsGateway(options)).rejects.toThrow("STATE_INVALID");
    await chmod(stateDirectory, 0o700);
    await writeFile(join(stateDirectory, "endpoint.key"), "a".repeat(64), { mode: 0o644 });
    await expect(createWorkCommandsGateway(options)).rejects.toThrow("STATE_INVALID");
  });
  it("authorizes only explicitly enrolled endpoint and exact procedure types; files are never allowed", () => {
    const context = (path: string, type = "mutation", remotePeerId = "a") => ({ principal: { id: remotePeerId }, remotePeerId, action: { kind: "rpc", path, type } }) as AuthorizationContext;
    expect(authorizeWorkHost(context("submit"), undefined, true)).toBe(false);
    expect(authorizeWorkHost(context("enroll"), undefined, false)).toBe(false);
    expect(authorizeWorkHost(context("enroll"), undefined, true)).toBe(true);
    expect(authorizeWorkHost(context("submit"), "a", false)).toBe(true);
    expect(authorizeWorkHost(context("submit", "query"), "a", false)).toBe(false);
    expect(authorizeWorkHost(context("get", "query"), "a", false)).toBe(true);
    expect(authorizeWorkHost(context("get", "mutation"), "a", false)).toBe(false);
    expect(authorizeWorkHost(context("submit", "mutation", "b"), "a", true)).toBe(false);
    expect(authorizeWorkHost(context("enroll", "mutation", "b"), "a", true)).toBe(false);
    expect(authorizeWorkHost({ ...context("submit"), principal: { id: "b" } } as AuthorizationContext, "a", false)).toBe(false);
    expect(authorizeWorkHost({ ...context("submit"), action: { kind: "file.pull" } } as AuthorizationContext, "a", true)).toBe(false);
  });

  it("rejects duplicates, protocol-source endpoint collisions, and orphan work descriptors", () => {
    const host = { sourceId: "work-wsl", name: "Work WSL", platform: "wsl", endpointId: "a".repeat(52), locator: { kind: "ticket", ticket: "fixture" } };
    expect(validateWorkHostPairings([host], [{ sourceId: "work-wsl", endpointId: "b".repeat(52) }])).toHaveLength(1);
    expect(() => validateWorkHostPairings([host, host])).toThrow("PAIRING_CONFLICT");
    expect(() => validateWorkHostPairings([host], [{ sourceId: "work-wsl", endpointId: host.endpointId }])).toThrow("PAIRING_CONFLICT");
    expect(() => validateWorkHostPairings([host], [{ sourceId: "personal", endpointId: "b".repeat(52) }])).toThrow("PAIRING_CONFLICT");
    expect(validateWorkHostPairings(undefined)).toEqual([]);
  });

  it("enrolls one gateway, executes without a native harness, preserves identities through restart and rejects retargeting", async () => {
    const hostState = await state(); const gatewayState = await state(); const bindAddress = `0.0.0.0:${await port()}`;
    const backend = executor();
    const options = { stateDirectory: hostState, sourceId: "work-wsl", name: "Work WSL", platform: "wsl" as const,
      sharedSecret: secret, enrollGateways: true, bindAddress, executor: backend };
    const host = await createWorkCommandHost(options); closes.push(() => host.close());
    const gateway = await createWorkCommandsGateway({ stateDirectory: gatewayState, sharedSecret: secret, hosts: [host.pairing] }); closes.push(() => gateway.close());
    expect(await gateway.hosts()).toEqual([{ sourceId: "work-wsl", name: "Work WSL", platform: "wsl", endpointId: host.pairing.endpointId, available: true }]);
    const input = { target: { sourceId: host.pairing.sourceId, endpointId: host.pairing.endpointId }, request: request() };
    const record = await gateway.submit(input);
    expect(record.stdout).toBe("fixture output");
    expect(await gateway.get({ target: input.target, operationId: input.request.operationId })).toEqual(record);
    expect(backend.submit).toHaveBeenCalledTimes(1);
    await expect(gateway.submit({ ...input, target: { ...input.target, sourceId: "personal" } })).rejects.toThrow("HOST_NOT_CONFIGURED");
    const firstPin = JSON.parse(await readFile(join(hostState, "gateway-peer.json"), "utf8"));
    await host.close();
    expect((await gateway.hosts())[0]?.available).toBe(false);
    const restarted = await createWorkCommandHost({ ...options, enrollGateways: false }); closes.push(() => restarted.close());
    expect(restarted.pairing.endpointId).toBe(host.pairing.endpointId);
    expect((await gateway.hosts())[0]?.available).toBe(true);
    await gateway.close();
    const sameGateway = await createWorkCommandsGateway({ stateDirectory: gatewayState, sharedSecret: secret, hosts: [host.pairing] }); closes.push(() => sameGateway.close());
    expect((await sameGateway.hosts())[0]?.available).toBe(true);
    expect(JSON.parse(await readFile(join(hostState, "gateway-peer.json"), "utf8"))).toEqual(firstPin);
    const stranger = await createWorkCommandsGateway({ stateDirectory: await state(), sharedSecret: secret, hosts: [restarted.pairing] }); closes.push(() => stranger.close());
    await expect(stranger.submit(input)).rejects.toThrow("UNAVAILABLE");
    expect(backend.submit).toHaveBeenCalledTimes(1);
    await expect(createWorkCommandHost({ ...options, sourceId: "different-host" })).rejects.toThrow("IDENTITY_MISMATCH");
  }, 30_000);

  it("does not retry a dispatched command when its connection disappears", async () => {
    const backend = executor();
    let dispatched!: () => void;
    const admitted = new Promise<void>(resolve => { dispatched = resolve; });
    let finish!: (record: WorkCommandRecord) => void;
    backend.submit.mockImplementation(async () => { dispatched(); return new Promise<WorkCommandRecord>(resolve => { finish = resolve; }); });
    const host = await createWorkCommandHost({ stateDirectory: await state(), sourceId: "work-wsl", name: "Work WSL", platform: "wsl",
      sharedSecret: secret, enrollGateways: true, bindAddress: `0.0.0.0:${await port()}`, executor: backend }); closes.push(() => host.close());
    const gateway = await createWorkCommandsGateway({ stateDirectory: await state(), sharedSecret: secret, hosts: [host.pairing] }); closes.push(() => gateway.close());
    const command = request();
    const outcome = gateway.submit({ target: { sourceId: host.pairing.sourceId, endpointId: host.pairing.endpointId }, request: command });
    const rejected = expect(outcome).rejects.toThrow("OUTCOME_UNKNOWN");
    await admitted;
    const closing = host.close();
    await rejected;
    finish({ ...command, payloadHash: "a".repeat(64), state: "completed", stdout: "fixture", stderr: "", truncated: false,
      exitCode: 0, signal: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    await closing;
    expect(backend.submit).toHaveBeenCalledTimes(1);
  }, 30_000);
});
