import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import WebSocket from "ws";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { createAccessAuthenticator } from "../apps/server/src/auth.js";
import { createPersonalHttpSurface } from "../apps/server/src/http.js";

const config = { publicOrigin: "https://agents.example.test", teamDomain: "https://leo-test.cloudflareaccess.com", audience: "test-app", email: "owner@example.test" };
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map((close) => close())); });

async function fixture(expiration = 60) {
  const pair = await generateKeyPair("RS256");
  const publicKey = await exportJWK(pair.publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...publicKey, kid: "fixture", alg: "RS256" }] });
  const token = await new SignJWT({ email: config.email }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(config.teamDomain).setAudience(config.audience).setSubject("fixture-owner").setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiration).sign(pair.privateKey);
  const surface = createPersonalHttpSurface(new AccessGatewayProjection([]), "test-instance", config, createAccessAuthenticator(config, keys));
  closes.push(() => surface.close());
  await new Promise<void>((resolve) => surface.server.listen(0, "127.0.0.1", resolve));
  const address = surface.server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  return { url: `http://127.0.0.1:${address.port}`, token };
}

describe("personal HTTP/WebSocket edge", () => {
  it("exposes only an empty health check without authentication", async () => {
    const { url, token } = await fixture();
    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
    expect((await fetch(`${url}/trpc/system.describe`)).status).toBe(401);
    const response = await fetch(`${url}/trpc/system.describe`, { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('"dataAuthority":"none"');
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await fetch(`${url}/auth/check`, { headers: { "Cf-Access-Jwt-Assertion": token } })).status).toBe(204);
  });
  it("rejects websocket upgrades before connection without a valid identity and origin", async () => {
    const { url, token } = await fixture();
    for (const headers of [{}, { "Cf-Access-Jwt-Assertion": token }, { "Cf-Access-Jwt-Assertion": token, origin: "https://evil.example.test" }]) {
      const socket = new WebSocket(url.replace("http", "ws") + "/trpc", { headers });
      const status = await new Promise<number>((resolve, reject) => {
        socket.once("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
        socket.on("error", () => {});
        socket.once("open", () => { socket.terminate(); reject(new Error("Unauthenticated websocket opened")); });
      });
      expect(status).toBe(401);
    }
  });
  it("expires authenticated websocket connections", async () => {
    const { url, token } = await fixture(2);
    const socket = new WebSocket(url.replace("http", "ws") + "/trpc", { headers: { "Cf-Access-Jwt-Assertion": token, origin: config.publicOrigin } });
    const closed = new Promise<number>((resolve, reject) => { socket.once("close", (code) => resolve(code)); socket.once("error", reject); });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    expect(await closed).toBe(4401);
  });
});
