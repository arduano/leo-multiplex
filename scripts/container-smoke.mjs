import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { createAccessAuthenticator } from "../dist/apps/server/src/auth.js";
import { createPersonalHttpSurface } from "../dist/apps/server/src/http.js";
import { runPersonalServer } from "../dist/apps/server/src/main.js";

await assert.rejects(runPersonalServer({}, new AbortController().signal), /LEO_PUBLIC_ORIGIN is required/);

// Disposable local signing keys exercise the shipped HTTP edge. Production
// configuration has no key override and always uses Cloudflare's pinned JWKS.
const config = { publicOrigin: "https://agents.example.test", teamDomain: "https://fixture.cloudflareaccess.com", audience: "fixture", email: "owner@example.test" };
const pair = await generateKeyPair("RS256");
const key = { ...await exportJWK(pair.publicKey), kid: "smoke", alg: "RS256" };
const token = await new SignJWT({ email: config.email }).setProtectedHeader({ alg: "RS256", kid: key.kid })
  .setIssuer(config.teamDomain).setAudience(config.audience).setSubject("smoke")
  .setIssuedAt().setExpirationTime("1m").sign(pair.privateKey);
const authenticate = createAccessAuthenticator(config, createLocalJWKSet({ keys: [key] }));
const surface = createPersonalHttpSurface(new AccessGatewayProjection([]), "smoke", config, authenticate);
try {
  await new Promise((resolve) => surface.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${surface.server.address().port}`;
  assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { ok: true });
  assert.equal((await fetch(origin)).status, 401);
  assert.equal((await fetch(`${origin}/trpc/system.describe`)).status, 401);
  const headers = { "Cf-Access-Jwt-Assertion": token };
  const page = await fetch(origin, { headers });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /Leo Multiplex/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(assets.length >= 2, "Built script and stylesheet must be present");
  for (const asset of assets) {
    const response = await fetch(origin + asset, { headers });
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await fetch(`${origin}/auth/check`, { headers })).status, 204);
  const describe = await fetch(`${origin}/trpc/system.describe`, { headers });
  assert.equal(describe.status, 200);
  assert.match(JSON.stringify(await describe.json()), /"dataAuthority":"none"/);
  const wrongOrigin = await fetch(`${origin}/auth/check`, { method: "POST", headers: { ...headers, origin: "https://wrong.example.test" } });
  assert.equal(wrongOrigin.status, 401);
  console.log(JSON.stringify({ ok: true, builtAssets: assets.length, authentication: "local disposable RS256 fixture", modelCalls: 0 }));
} finally {
  await surface.close();
}

const tailConfig = { mode: "tailscale", publicOrigin: "http://100.64.0.2:8444", email: "owner@example.test" };
await assert.rejects(runPersonalServer({ LEO_AUTH_MODE: "tailscale", LEO_PUBLIC_ORIGIN: tailConfig.publicOrigin, LEO_ACCESS_EMAIL: tailConfig.email, LEO_HTTP_BIND: "0.0.0.0" }, new AbortController().signal), /loopback/);
const tailSurface = createPersonalHttpSurface(new AccessGatewayProjection([]), "tailscale-smoke", tailConfig);
try {
  await new Promise((resolve) => tailSurface.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${tailSurface.server.address().port}`;
  assert.equal((await fetch(`${origin}/auth/session`)).status, 401);
  assert.equal((await fetch(`${origin}/auth/session`, { headers: { "Tailscale-User-Login": "wrong@example.test" } })).status, 401);
  const headers = { "Tailscale-User-Login": tailConfig.email };
  assert.deepEqual(await (await fetch(`${origin}/auth/session`, { headers })).json(), { method: "tailscale" });
  assert.equal((await fetch(origin, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/auth/check`, { method: "POST", headers: { ...headers, origin: "https://wrong.example.test" } })).status, 401);
  console.log(JSON.stringify({ ok: true, authentication: "Tailscale loopback fixture", modelCalls: 0 }));
} finally {
  await tailSurface.close();
}
