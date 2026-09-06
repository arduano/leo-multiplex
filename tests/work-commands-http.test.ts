import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { createAuthenticator, type AccessIdentity } from "../apps/server/src/auth.js";
import { createPersonalHttpSurface } from "../apps/server/src/http.js";
import { WorkCommandTransportError } from "../packages/work-commands/src/transport.js";
import type { WorkCommandsPort } from "../packages/work-commands/src/contract.js";

const config = { mode: "tailscale" as const, publicOrigin: "http://100.64.0.1:8444", email: "owner@example.test" };
const target = { sourceId: "work-wsl", endpointId: "a".repeat(52) };
const headers = { "tailscale-user-login": config.email, "content-type": "application/json", origin: config.publicOrigin };
const input = () => ({ target, request: { operationId: randomUUID(), cwd: "/work", command: "pwd", timeoutMs: 1_000 } });
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });
async function fixture(scopes: "control" | "read" = "control", commands?: Partial<WorkCommandsPort>) {
  const calls = { hosts: vi.fn(async () => [{ ...target, name: "Work WSL", platform: "wsl" as const, available: true }]),
    submit: vi.fn(async () => { throw new WorkCommandTransportError("BUSY"); }), get: vi.fn(async () => null), cancel: vi.fn(async () => null), ...commands };
  const authenticate = createAuthenticator(config);
  const surface = createPersonalHttpSurface(new AccessGatewayProjection([]), "fixture", config, async (req, ws) => {
    const identity = await authenticate(req, ws);
    if (scopes === "read") return { ...identity, context: { gatewayAccess: { authentication: "external", subject: "fixture", scopes: ["read"] } } } satisfies AccessIdentity;
    return identity;
  }, undefined, calls);
  closes.push(() => surface.close());
  await new Promise<void>(resolve => surface.server.listen(0, "127.0.0.1", resolve));
  const address = surface.server.address(); if (!address || typeof address === "string") throw new Error("fixture listener missing");
  return { url: `http://127.0.0.1:${address.port}/api/work-commands`, calls };
}

describe("work command HTTP edge", () => {
  it("uses the existing authentication and Origin defenses before execution", async () => {
    const { url, calls } = await fixture();
    expect((await fetch(`${url}/hosts`)).status).toBe(401);
    expect((await fetch(`${url}/submit`, { method: "POST", headers: { ...headers, origin: "https://untrusted.example" }, body: JSON.stringify(input()) })).status).toBe(401);
    const { origin: _origin, ...withoutOrigin } = headers;
    expect((await fetch(`${url}/submit`, { method: "POST", headers: withoutOrigin, body: JSON.stringify(input()) })).status).toBe(401);
    expect(calls.submit).not.toHaveBeenCalled();
    const oversized = await fetch(`${url}/submit`, { method: "POST", headers, body: JSON.stringify({ padding: "x".repeat(131_072) }) });
    expect(oversized.status).toBe(400);
    expect(calls.submit).not.toHaveBeenCalled();
    expect(await (await fetch(`${url}/hosts`, { headers })).json()).toEqual([{ ...target, name: "Work WSL", platform: "wsl", available: true }]);
  });
  it("requires terminal-control even for output reads and discovery", async () => {
    const { url, calls } = await fixture("read");
    expect((await fetch(`${url}/hosts`, { headers })).status).toBe(403);
    for (const route of ["submit", "get", "cancel"]) {
      expect((await fetch(`${url}/${route}`, { method: "POST", headers, body: JSON.stringify(input()) })).status).toBe(403);
    }
    expect(calls.hosts).not.toHaveBeenCalled(); expect(calls.get).not.toHaveBeenCalled(); expect(calls.submit).not.toHaveBeenCalled();
  });
  it("accepts only bounded validated POST bodies and keeps application errors scrubbed", async () => {
    const { url, calls } = await fixture();
    expect((await fetch(`${url}/get`, { headers })).status).toBe(405);
    const invalid = await fetch(`${url}/submit`, { method: "POST", headers, body: JSON.stringify({ ...input(), unwanted: "extra" }) });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: { code: "INVALID_INPUT" } });
    expect(calls.submit).not.toHaveBeenCalled();
    const busy = await fetch(`${url}/submit`, { method: "POST", headers, body: JSON.stringify(input()) });
    expect(busy.status).toBe(409); expect(await busy.json()).toEqual({ error: { code: "BUSY" } });
    const { url: broken } = await fixture("control", { get: async () => { throw new Error("private diagnostic text"); } });
    const failure = await fetch(`${broken}/get`, { method: "POST", headers, body: JSON.stringify({ target, operationId: randomUUID() }) });
    expect(await failure.text()).toBe('{"error":{"code":"UNAVAILABLE"}}\n');
  });
  it("returns unknown outcome without reissuing a mutation", async () => {
    const submit = vi.fn(async () => { throw new WorkCommandTransportError("OUTCOME_UNKNOWN"); });
    const { url } = await fixture("control", { submit });
    const response = await fetch(`${url}/submit`, { method: "POST", headers, body: JSON.stringify(input()) });
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: { code: "OUTCOME_UNKNOWN" } }); expect(submit).toHaveBeenCalledTimes(1);
  });
});
