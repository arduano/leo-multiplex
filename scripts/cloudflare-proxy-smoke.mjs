// Run inside the built Leo image with a private shared socket directory and a
// disposable Docker network. No pairing, production credentials or model calls.
import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { once } from "node:events";
import WebSocket from "ws";
import { generateKeyPair, SignJWT } from "jose";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { createAccessAuthenticator } from "../dist/apps/server/src/auth.js";
import { createPersonalHttpSurface } from "../dist/apps/server/src/http.js";

const config = { mode: "cloudflare", publicOrigin: "https://agents.example.test", teamDomain: "https://fixture.cloudflareaccess.com", audience: "fixture", email: "owner@example.test" };
const { publicKey, privateKey } = await generateKeyPair("RS256");
const sign = expiration => new SignJWT({ email: config.email }).setProtectedHeader({ alg: "RS256" })
  .setIssuer(config.teamDomain).setAudience(config.audience).setSubject("fixture")
  .setIssuedAt().setExpirationTime(expiration).sign(privateKey);
const projection = new AccessGatewayProjection([]);
const surface = createPersonalHttpSurface(projection, "fixture", config, createAccessAuthenticator(config, async () => publicKey));
const tailscale = createPersonalHttpSurface(projection, "fixture", { mode: "tailscale", publicOrigin: "http://100.64.0.2:8444", email: config.email });
let tailSocket;
try {
  surface.server.listen("/run/leo-cloudflare/access.sock");
  await once(surface.server, "listening");
  await chmod("/run/leo-cloudflare/access.sock", 0o600);
  tailscale.server.listen(0, "127.0.0.1");
  await once(tailscale.server, "listening");
  const url = "http://multiplex-gatreway:8444";
  const get = (path, headers = {}, method = "GET") => fetch(url + path, { method, headers, signal: AbortSignal.timeout(5_000) });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await get("/healthz")).status === 200) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, "Compose DNS proxy must reach Unix origin");
  const token = await sign("5m");
  const headers = { "Cf-Access-Jwt-Assertion": token };
  for (const path of ["/", "/auth/session", "/trpc/system.describe", "/trpc/images.read"]) {
    assert.equal((await get(path)).status, 401);
    assert.equal((await get(path, { "Tailscale-User-Login": config.email })).status, 401);
  }
  assert.deepEqual(await (await get("/auth/session", headers)).json(), { method: "cloudflare" });
  const page = await get("/", headers);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
  assert(assets.length >= 2);
  for (const path of assets) assert.equal((await get(path, headers)).status, 200);
  assert.equal((await get("/auth/check", { ...headers, origin: config.publicOrigin }, "POST")).status, 204);
  assert.equal((await get("/auth/check", headers, "POST")).status, 401);
  assert.equal((await get("/auth/check", { ...headers, origin: "http://100.64.0.2:8444" }, "POST")).status, 401);
  for (const socketHeaders of [{}, headers, { ...headers, origin: "https://evil.example.test" }]) {
    const socket = new WebSocket(url.replace("http", "ws") + "/trpc", { headers: socketHeaders });
    socket.on("error", () => {});
    const [request, response] = await once(socket, "unexpected-response");
    assert.equal(response.statusCode, 401); response.resume(); request.destroy(); socket.terminate();
  }
  tailSocket = new WebSocket(`ws://127.0.0.1:${tailscale.server.address().port}/trpc`, { headers: { "Tailscale-User-Login": config.email, origin: "http://100.64.0.2:8444" } });
  await once(tailSocket, "open");
  const short = await sign("2s");
  const socket = new WebSocket(url.replace("http", "ws") + "/trpc", { headers: { "Cf-Access-Jwt-Assertion": short, origin: config.publicOrigin } });
  const closed = once(socket, "close");
  await once(socket, "open");
  const [code] = await closed;
  assert.equal(code, 4401);
  assert.equal(tailSocket.readyState, WebSocket.OPEN);
  console.log(JSON.stringify({ ok: true, composeDNS: true, privateSocketUpstream: true, builtAssets: assets.length, authenticationIsolation: true, originsEnforced: true, websocketUpgradeAndExpiry: true, tailscaleSurvivesExpiry: true, modelCalls: 0 }));
} finally {
  tailSocket?.terminate();
  await Promise.all([surface.close(), tailscale.close()]);
}
