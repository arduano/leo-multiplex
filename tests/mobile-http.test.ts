import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import type { SessionRecord } from "@arduano/agent-multiplex-protocol";
import { createAccessAuthenticator } from "../apps/server/src/auth.js";
import { createPersonalHttpSurface } from "../apps/server/src/http.js";
import { MobileNotifications } from "../apps/server/src/mobile-notifications.js";
const access = { publicOrigin: "https://agents.example.test", teamDomain: "https://leo-test.cloudflareaccess.com", audience: "test-app", email: "owner@example.test" };
const deviceId = "00000000-0000-4000-8000-000000000010";
const sessionId = "00000000-0000-4000-8000-000000000001";
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map((close) => close())); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "leo-mobile-http-"));
  const pair = await generateKeyPair("RS256");
  const publicKey = await exportJWK(pair.publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...publicKey, kid: "fixture", alg: "RS256" }] });
  const sign = (email: string) => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(access.teamDomain).setAudience(access.audience).setSubject("fixture-owner").setIssuedAt().setExpirationTime("1m").sign(pair.privateKey);
  const token = await sign(access.email);
  const mobile = new MobileNotifications({ databasePath: join(directory, "mobile.sqlite"), publicOrigin: access.publicOrigin, publicKey: "public-fixture-key", sender: async () => {}, automaticDelivery: false });
  const projection = new AccessGatewayProjection([]);
  const session = { sessionId, runtimeNodeId: "runtime", adapterScopeId: "scope", harness: "codex", vendorSessionId: "root-thread", runtimeEpoch: "epoch", bindingRevision: 1, metadata: { values: {} } } as unknown as SessionRecord;
  projection.getSession = async (id) => id === sessionId ? session : null;
  const surface = createPersonalHttpSurface(projection, "fixture-instance", access, createAccessAuthenticator(access, keys), mobile);
  closes.push(async () => { await surface.close(); await mobile.close(); await rm(directory, { recursive: true, force: true }); });
  await new Promise<void>((resolve) => surface.server.listen(0, "127.0.0.1", resolve));
  const address = surface.server.address(); if (!address || typeof address === "string") throw new Error("No listener");
  const url = `http://127.0.0.1:${address.port}`;
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const device = { name: "Pixel", enabled: true, categories: { completion: true, input: true, error: true }, subscription: {
    endpoint: "https://fcm.googleapis.com/fcm/send/disposable", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  } };
  const headers = { "Cf-Access-Jwt-Assertion": token, Origin: access.publicOrigin, "Content-Type": "application/json" };
  return { url, token, sign, device, mobile, headers, fetch: (path: string, method = "GET", body?: unknown) => fetch(`${url}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) };
}

describe("authenticated mobile HTTP API", () => {
  it("protects every route with the configured owner and exact-origin rules", async () => {
    const f = await fixture();
    const wrongToken = await f.sign("other@example.test");
    const routes = [["/api/mobile/config", "GET"], ["/api/mobile/state", "GET"], ["/api/mobile/activity", "GET"], [`/api/mobile/devices/${deviceId}`, "PUT"], [`/api/mobile/devices/${deviceId}`, "DELETE"], [`/api/mobile/devices/${deviceId}/test`, "POST"], [`/api/mobile/watches/${sessionId}`, "PUT"]];
    for (const [path, method] of routes) {
      expect((await fetch(`${f.url}${path}`, { method })).status).toBe(401);
      expect((await fetch(`${f.url}${path}`, { method, headers: { ...f.headers, "Cf-Access-Jwt-Assertion": wrongToken } })).status).toBe(401);
      expect((await fetch(`${f.url}${path}`, { method, headers: { ...f.headers, Origin: "https://evil.test" } })).status).toBe(401);
      if (method !== "GET") expect((await fetch(`${f.url}${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": f.token } })).status).toBe(401);
    }
  });
  it("registers devices, watches explicitly, tests, revokes, and returns only public fields", async () => {
    const f = await fixture();
    const config = await (await f.fetch("/api/mobile/config")).json();
    expect(config).toMatchObject({ enabled: true, publicKey: "public-fixture-key", origin: access.publicOrigin });
    const auth = await (await f.fetch("/auth/session")).json(); expect(config.storageScope).toBe(auth.storageScope);
    expect((await (await f.fetch("/api/mobile/state")).json()).watchedSessionIds).toEqual([]);
    const activity = await f.fetch("/api/mobile/activity");
    expect(activity.status).toBe(200);
    expect(activity.headers.get("cache-control")).toBe("no-store");
    expect(await activity.json()).toEqual({ sessions: [] });
    const registered = await (await f.fetch(`/api/mobile/devices/${deviceId}`, "PUT", f.device)).json();
    expect(registered).toMatchObject({ id: deviceId, name: "Pixel", enabled: true });
    expect(JSON.stringify(registered)).not.toContain("subscription");
    const watched = await (await f.fetch(`/api/mobile/watches/${sessionId}`, "PUT", { watched: true })).json();
    expect(watched.watchedSessionIds).toEqual([sessionId]);
    expect((await f.fetch(`/api/mobile/devices/${deviceId}/test`, "POST")).status).toBe(200);
    expect(f.mobile.state().delivery.pending).toBe(1);
    const state = await (await f.fetch("/api/mobile/state")).json();
    expect(JSON.stringify(state)).not.toContain("fcm.googleapis.com");
    expect((await f.fetch(`/api/mobile/devices/${deviceId}`, "DELETE")).status).toBe(200);
    expect(f.mobile.state().devices).toEqual([]); expect(f.mobile.state().delivery.pending).toBe(0);
    expect((await f.fetch(`/api/mobile/watches/${sessionId}`, "PUT", { watched: false })).status).toBe(200);
    expect(f.mobile.state().watchedSessionIds).toEqual([]);
  });
  it("rejects unknown sessions, malformed input, endpoints, oversized bodies without echoing secrets", async () => {
    const f = await fixture();
    expect((await f.fetch("/api/mobile/watches/00000000-0000-4000-8000-000000000099", "PUT", { watched: true })).status).toBe(404);
    const invalid = { ...f.device, subscription: { ...f.device.subscription, endpoint: "https://private-secret.example.test" } };
    const response = await f.fetch(`/api/mobile/devices/${deviceId}`, "PUT", invalid);
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("private-secret");
    expect((await f.fetch(`/api/mobile/watches/${sessionId}`, "PUT", { watched: "true" })).status).toBe(400);
    expect((await f.fetch(`/api/mobile/devices/${deviceId}`, "PUT", { huge: "x".repeat(9_000) })).status).toBe(413);
    expect((await f.fetch(`/api/mobile/devices/${deviceId}/test`, "POST")).status).toBe(400);
    expect((await f.fetch("/api/mobile/unknown")).status).toBe(404);
  });
});
