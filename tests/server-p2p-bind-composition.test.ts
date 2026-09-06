import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const components = vi.hoisted(() => ({
  gateway: vi.fn(async (_options: Record<string, unknown>, _signal: AbortSignal, _dependencies: unknown) => undefined),
  recovery: vi.fn(async (_options: Record<string, unknown>) => ({ close: components.closeRecovery })),
  closeRecovery: vi.fn(async () => undefined),
  closeMobile: vi.fn(async () => undefined),
}));
vi.mock("../apps/server/src/gateway.js", () => ({ runPersonalGateway: components.gateway }));
vi.mock("../apps/server/src/mobile-notifications.js", () => ({
  openMobileNotifications: async () => ({ close: components.closeMobile }),
}));
vi.mock("../apps/server/src/http.js", () => ({ createPersonalHttpSurface: vi.fn() }));
vi.mock("../packages/work-commands/src/transport.js", async () => ({
  createWorkCommandsGateway: components.recovery,
  validateWorkHostPairings: (await import("../packages/work-commands/src/contract.js")).validateWorkHostPairings,
}));
import { runPersonalServer } from "../apps/server/src/main.js";

const directories: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function environment(withWorkHost = true): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "leo-server-bind-"));
  directories.push(directory);
  const pairingFile = join(directory, "pairing.json");
  await writeFile(pairingFile, JSON.stringify({
    version: 1, sharedSecret: "disposable-server-composition-shared-value",
    sources: [{ sourceId: "work-windows", endpointId: "a".repeat(52), locator: { kind: "ticket", ticket: "disposable-control-locator" } }],
    ...(withWorkHost ? { workHosts: [{ sourceId: "work-windows", name: "Windows fixture", platform: "windows", endpointId: "b".repeat(52), locator: { kind: "ticket", ticket: "disposable-work-locator" } }] } : {}),
  }), { mode: 0o600 });
  return {
    LEO_AUTH_MODE: "tailscale", LEO_PUBLIC_ORIGIN: "http://100.64.0.1:8444", LEO_ACCESS_EMAIL: "fixture@example.invalid",
    LEO_PAIRING_FILE: pairingFile, LEO_GATEWAY_STATE_DIR: join(directory, "gateway"),
  };
}

it("passes the configured P2P bind to both normal and recovery gateway transports", async () => {
  const config = await environment();
  config.LEO_GATEWAY_P2P_BIND = "100.64.12.34:0";
  await runPersonalServer(config, new AbortController().signal);
  expect(components.gateway).toHaveBeenCalledOnce();
  expect(components.gateway.mock.calls[0]![0]).toMatchObject({ p2pBindAddress: config.LEO_GATEWAY_P2P_BIND, bindAddress: "127.0.0.1" });
  expect(components.recovery).toHaveBeenCalledOnce();
  expect(components.recovery.mock.calls[0]![0]).toMatchObject({ bindAddress: config.LEO_GATEWAY_P2P_BIND });
  expect(components.closeRecovery).toHaveBeenCalledOnce();
  expect(components.closeMobile).toHaveBeenCalledOnce();
});

it("preserves each transport's default when no P2P bind is configured", async () => {
  await runPersonalServer(await environment(), new AbortController().signal);
  expect(components.gateway).toHaveBeenCalledOnce();
  expect(components.recovery).toHaveBeenCalledOnce();
  expect(components.gateway.mock.calls[0]![0]).not.toHaveProperty("p2pBindAddress");
  expect(components.recovery.mock.calls[0]![0]).not.toHaveProperty("bindAddress");
});

it("does not construct recovery transport when pairing has no work-host profile", async () => {
  const config = await environment(false);
  config.LEO_GATEWAY_P2P_BIND = "100.64.12.34:0";
  await runPersonalServer(config, new AbortController().signal);
  expect(components.gateway).toHaveBeenCalledOnce();
  expect(components.gateway.mock.calls[0]![0]).toHaveProperty("p2pBindAddress", config.LEO_GATEWAY_P2P_BIND);
  expect(components.recovery).not.toHaveBeenCalled();
  expect(components.closeRecovery).not.toHaveBeenCalled();
  expect(components.closeMobile).toHaveBeenCalledOnce();
});
