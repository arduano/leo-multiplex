import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlNodeCatalog, ControlNodeService } from "@arduano/agent-multiplex-control-node-core";
import { GatewayOperationalStore, type ControlNodeSourceClient } from "@arduano/agent-multiplex-gateway-core";
import { sourceIdSchema } from "@arduano/agent-multiplex-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { controlSource } from "./helpers/in-process-roles.js";
import { createPersonalHttpSurface } from "../apps/server/src/http.js";
import { createAccessAuthenticator } from "../apps/server/src/auth.js";
import { generateKeyPair, SignJWT } from "jose";

const transport = vi.hoisted(() => ({ create: vi.fn(), client: undefined as unknown, close: vi.fn() }));
vi.mock("@arduano/agent-multiplex-client-p2prpc", () => ({
  createP2PAccessGatewayNode: transport.create,
  P2PControlNodeSourceClient: function () { return transport.client; },
}));
import { runPersonalGateway } from "../apps/server/src/gateway.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

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

const tailscaleAccess = { mode: "tailscale" as const, email: "owner@example.test", publicOrigin: "http://100.64.0.2:8444" };
const cloudflareAccess = {
  mode: "cloudflare" as const, email: tailscaleAccess.email, publicOrigin: "https://agents.example.test",
  teamDomain: "https://fixture.cloudflareaccess.com", audience: "fixture-app",
};

async function dualListenerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "leo-gateway-listeners-"));
  directories.push(directory);
  transport.close.mockResolvedValue(undefined);
  transport.create.mockResolvedValue({ sources: new Map(), localEndpointId: "fixture-gateway", close: transport.close });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    directory, socketPath: join(directory, "access.sock"), controller: new AbortController(),
    config: {
      sharedSecret: "disposable-multiple-listener-shared-secret", identityPath: join(directory, "identity"), statePath: join(directory, "gateway.sqlite"),
      sources: [], bindAddress: "127.0.0.1", port: 0, reconnectMaxMs: 10,
    },
  };
}

function socketRequest(socketPath: string, path = "/auth/session", headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number | undefined; body: string }>((resolveRequest, rejectRequest) => {
    const request = httpRequest({ socketPath, path, headers, method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => body += chunk);
      response.once("end", () => resolveRequest({ status: response.statusCode, body }));
      response.once("error", rejectRequest);
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

it("serves independently authenticated TCP and private Unix edges from one gateway and closes both", async () => {
  const fixture = await dualListenerFixture();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const assertion = await new SignJWT({ email: cloudflareAccess.email }).setProtectedHeader({ alg: "RS256" })
    .setIssuer(cloudflareAccess.teamDomain).setAudience(cloudflareAccess.audience).setSubject("fixture-owner")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const authenticate = createAccessAuthenticator(cloudflareAccess, async () => publicKey);
  const surfaces: ReturnType<typeof createPersonalHttpSurface>[] = [];
  const projections: unknown[] = [];
  const identities: string[] = [];
  const running = runPersonalGateway(fixture.config, fixture.controller.signal, {
    httpSurface: { authentication: "external", create: (projection, identity) => {
      projections.push(projection); identities.push(identity);
      const surface = createPersonalHttpSurface(projection, identity, tailscaleAccess); surfaces.push(surface); return surface;
    } },
    additionalHttpSurfaces: [{ socketPath: fixture.socketPath, httpSurface: { authentication: "external", create: (projection, identity) => {
      projections.push(projection); identities.push(identity);
      const surface = createPersonalHttpSurface(projection, identity, cloudflareAccess, authenticate); surfaces.push(surface); return surface;
    } } }],
  });
  try {
    await vi.waitFor(() => { expect(surfaces).toHaveLength(2); expect(surfaces.every((surface) => surface.server.listening)).toBe(true); });
    await vi.waitFor(async () => expect((await lstat(fixture.socketPath)).mode & 0o777).toBe(0o600));
    expect(projections[0]).toBe(projections[1]);
    expect(identities).toEqual(["fixture-gateway", "fixture-gateway"]);
    expect(transport.create).toHaveBeenCalledTimes(1);
    const address = surfaces[0]!.server.address();
    if (!address || typeof address === "string") throw new Error("Missing primary listener");
    const url = `http://127.0.0.1:${address.port}`;
    const headers = { "Cf-Access-Jwt-Assertion": assertion };
    expect((await fetch(`${url}/auth/session`, { headers })).status).toBe(401);
    expect(await (await fetch(`${url}/auth/session`, { headers: { "Tailscale-User-Login": tailscaleAccess.email } })).json()).toEqual({ method: "tailscale" });
    expect((await socketRequest(fixture.socketPath, "/auth/session", { "Tailscale-User-Login": tailscaleAccess.email })).status).toBe(401);
    expect((await socketRequest(fixture.socketPath, "/auth/session", headers))).toMatchObject({ status: 200, body: '{"method":"cloudflare"}\n' });
    expect((await socketRequest(fixture.socketPath, "/auth/check", { ...headers, Origin: tailscaleAccess.publicOrigin }, "POST")).status).toBe(401);
    expect((await socketRequest(fixture.socketPath, "/auth/check", { ...headers, Origin: cloudflareAccess.publicOrigin }, "POST")).status).toBe(204);
    expect((await socketRequest(fixture.socketPath, "/trpc/system.describe", headers)).body).toContain('"dataAuthority":"none"');
  } finally { fixture.controller.abort(); await running; }
  expect(surfaces.every((surface) => !surface.server.listening)).toBe(true);
  await expect(lstat(fixture.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["file", "symlink", "public-directory", "symlink-directory", "active-socket"])("rejects an unsafe %s before starting transport or touching identity", async (kind) => {
  const fixture = await dualListenerFixture();
  let socketPath = fixture.socketPath;
  let occupied: ReturnType<typeof createServer> | undefined;
  if (kind === "file") await writeFile(socketPath, "preserve this file");
  if (kind === "symlink") {
    await writeFile(join(fixture.directory, "target"), "preserve this file");
    await symlink(join(fixture.directory, "target"), socketPath);
  }
  if (kind === "public-directory") await chmod(fixture.directory, 0o755);
  if (kind === "symlink-directory") {
    const alias = `${fixture.directory}-alias`; directories.push(alias);
    await symlink(fixture.directory, alias); socketPath = join(alias, "access.sock");
  }
  if (kind === "active-socket") {
    occupied = createServer(); occupied.listen(socketPath); await once(occupied, "listening");
  }
  const composition = {
    httpSurface: { authentication: "external" as const, create: (projection: Parameters<typeof createPersonalHttpSurface>[0], identity: string) => createPersonalHttpSurface(projection, identity, tailscaleAccess) },
    additionalHttpSurfaces: [{ socketPath, httpSurface: { authentication: "external" as const, create: (projection: Parameters<typeof createPersonalHttpSurface>[0], identity: string) => createPersonalHttpSurface(projection, identity, cloudflareAccess) } }],
  };
  try {
    await expect(runPersonalGateway(fixture.config, fixture.controller.signal, composition)).rejects.toThrow();
    expect(transport.create).not.toHaveBeenCalled();
    await expect(lstat(fixture.config.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "file") expect(await readFile(socketPath, "utf8")).toBe("preserve this file");
    if (kind === "symlink") expect((await lstat(socketPath)).isSymbolicLink()).toBe(true);
    if (kind === "active-socket") expect(occupied!.listening).toBe(true);
  } finally {
    if (occupied) await new Promise<void>((resolveClose) => occupied!.close(() => resolveClose()));
  }
});

it("recovers a stale socket left by an abruptly terminated process", async () => {
  const fixture = await dualListenerFixture();
  const child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1], () => process.send('ready'))", fixture.socketPath], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await once(child, "message");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    expect((await lstat(fixture.socketPath)).isSocket()).toBe(true);
    let secondary: ReturnType<typeof createPersonalHttpSurface> | undefined;
    const running = runPersonalGateway(fixture.config, fixture.controller.signal, {
      httpSurface: { authentication: "external", create: (projection, identity) => createPersonalHttpSurface(projection, identity, tailscaleAccess) },
      additionalHttpSurfaces: [{ socketPath: fixture.socketPath, httpSurface: { authentication: "external", create: (projection, identity) => secondary = createPersonalHttpSurface(projection, identity, cloudflareAccess) } }],
    });
    try {
      await vi.waitFor(() => expect(secondary?.server.listening).toBe(true));
      expect(await socketRequest(fixture.socketPath, "/healthz")).toMatchObject({ status: 200, body: '{"ok":true}\n' });
    } finally { fixture.controller.abort(); await running; }
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});

it("closes the primary listener and transport if the second socket changes during startup", async () => {
  const fixture = await dualListenerFixture();
  const surfaces: ReturnType<typeof createPersonalHttpSurface>[] = [];
  const running = runPersonalGateway(fixture.config, fixture.controller.signal, {
    httpSurface: { authentication: "external", create: (projection, identity) => {
      const surface = createPersonalHttpSurface(projection, identity, tailscaleAccess); surfaces.push(surface); return surface;
    } },
    additionalHttpSurfaces: [{ socketPath: fixture.socketPath, httpSurface: { authentication: "external", create: (projection, identity) => {
      writeFileSync(fixture.socketPath, "concurrent replacement must survive");
      const surface = createPersonalHttpSurface(projection, identity, cloudflareAccess); surfaces.push(surface); return surface;
    } } }],
  });
  await expect(running).rejects.toThrow("non-socket");
  expect(surfaces).toHaveLength(2);
  expect(surfaces.every((surface) => !surface.server.listening)).toBe(true);
  expect(transport.close).toHaveBeenCalled();
  expect(await readFile(fixture.socketPath, "utf8")).toBe("concurrent replacement must survive");
  const store = new GatewayOperationalStore(fixture.config.statePath); store.close();
});
