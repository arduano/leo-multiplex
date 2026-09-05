import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlNodeCatalog, ControlNodeService } from "@arduano/agent-multiplex-control-node-core";
import { GatewayOperationalStore, type ControlNodeSourceClient } from "@arduano/agent-multiplex-gateway-core";
import { sourceIdSchema } from "@arduano/agent-multiplex-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { controlSource } from "./helpers/in-process-roles.js";
import { createPersonalHttpSurface } from "../apps/server/src/http.js";

const transport = vi.hoisted(() => ({ create: vi.fn(), client: undefined as unknown, close: vi.fn() }));
vi.mock("@arduano/agent-multiplex-client-p2prpc", () => ({
  createP2PAccessGatewayNode: transport.create,
  P2PControlNodeSourceClient: function () { return transport.client; },
}));
import { runPersonalGateway } from "../apps/server/src/gateway.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("binds transport explicitly, serves an offline edge, reconnects and resynchronizes without catalog authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "leo-gateway-process-"));
  directories.push(directory);
  const catalog = new ControlNodeCatalog({ filename: join(directory, "control.sqlite"), controlNodeName: "fixture" });
  const control = new ControlNodeService({ catalog });
  const source = controlSource(control);
  const id = sourceIdSchema.parse("fixture");
  const controller = new AbortController();
  const access = { mode: "tailscale" as const, email: "owner@example.test", publicOrigin: "https://fixture.ts.net" };
  const config = { sharedSecret: "disposable-shared-secret-for-process-test", identityPath: join(directory, "identity"), statePath: join(directory, "gateway.sqlite"),
    sources: [{ sourceId: id, displayName: "fixture", endpointId: "fixture-endpoint", locator: { kind: "ticket" as const, ticket: "fixture-bootstrap" }, priority: 0, enabled: true, requestedScopes: ["read" as const] }],
    bindAddress: "127.0.0.1", port: 0, p2pBindAddress: "100.64.0.2:0", reconnectMaxMs: 10 };
  let online = false;
  let resetSent = false;
  const loadSnapshot = vi.fn(async () => { if (!online) throw new Error("disposable offline source"); return source.loadSnapshot(); });
  const reconnect = vi.fn(async () => {});
  transport.client = { ...source, loadSnapshot, reconnect, watch: async function* (cursor, signal) {
    if (!resetSent) { resetSent = true; yield { kind: "streamReset", reason: "history-compacted", feedId: cursor!.feedId, controlCursor: cursor!.controlCursor }; return; }
    if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  } } satisfies ControlNodeSourceClient & { reconnect: () => Promise<void> };
  transport.close.mockResolvedValue(undefined);
  transport.create.mockResolvedValue({ sources: new Map([[id, {}]]), localEndpointId: "fixture-gateway", close: transport.close });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  let surface: ReturnType<typeof createPersonalHttpSurface> | undefined;
  const running = runPersonalGateway(config, controller.signal, { httpSurface: { authentication: "external", create: (projection, identity) => surface = createPersonalHttpSurface(projection, identity, access) } });
  try {
    await vi.waitFor(() => expect(surface?.server.listening).toBe(true));
    const address = surface!.server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture server");
    const url = `http://127.0.0.1:${address.port}`;
    expect((await fetch(url)).status).toBe(401);
    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
    const headers = { "Tailscale-User-Login": access.email };
    expect(JSON.stringify(await (await fetch(`${url}/trpc/system.describe`, { headers })).json())).toContain('"dataAuthority":"none"');
    expect(transport.create.mock.calls[0]![0].iroh.bindAddress).toBe(config.p2pBindAddress);
    online = true;
    await vi.waitFor(() => { expect(reconnect).toHaveBeenCalled(); expect(resetSent).toBe(true); expect(loadSnapshot.mock.calls.length).toBeGreaterThanOrEqual(4); });
  } finally { controller.abort(); await running; catalog.close(); }
  expect(transport.close).toHaveBeenCalled();
  const store = new GatewayOperationalStore(config.statePath);
  try { expect(store.listSources()).toHaveLength(1); } finally { store.close(); }
});
