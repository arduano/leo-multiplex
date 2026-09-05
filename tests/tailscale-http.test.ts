import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { createTailscaleAuthenticator } from "../apps/server/src/auth.js";
import { createPersonalHttpSurface } from "../apps/server/src/http.js";

const config = { mode: "tailscale" as const, publicOrigin: "https://nas.fixture.ts.net", email: "owner@example.test" };
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map((close) => close())); });
const trusted = () => ({ "Tailscale-User-Login": config.email });

async function fixture(shortExpiry = false) {
  const authenticate = createTailscaleAuthenticator(config);
  const surface = createPersonalHttpSurface(new AccessGatewayProjection([]), "tailscale-fixture", config,
    shortExpiry ? async (request, websocket) => ({ ...await authenticate(request, websocket), expiresAt: Date.now() + 200 }) : authenticate);
  closes.push(() => surface.close());
  await new Promise<void>((resolve) => surface.server.listen(0, "127.0.0.1", resolve));
  const address = surface.server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  return `http://127.0.0.1:${address.port}`;
}

async function rejectedSocket(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url.replace("http", "ws") + "/trpc", { headers });
  return new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
    socket.on("error", () => {});
    socket.once("open", () => { socket.terminate(); reject(new Error("Forged WebSocket identity was accepted")); });
  });
}

describe("Tailscale HTTP/WebSocket edge", () => {
  it("requires the owner login on the trusted loopback listener and protects auth discovery", async () => {
    const url = await fixture();
    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
    for (const headers of [{}, { "Tailscale-User-Login": "another@example.test" }]) {
      expect((await fetch(`${url}/trpc/system.describe`, { headers })).status).toBe(401);
    }
    const response = await fetch(`${url}/trpc/system.describe`, { headers: trusted() });
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('"dataAuthority":"none"');
    expect((await fetch(`${url}/auth/session`)).status).toBe(401);
    const session = await fetch(`${url}/auth/session`, { headers: trusted() });
    expect(await session.json()).toEqual({ method: "tailscale" });
    expect(session.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${url}/auth/check`, { headers: trusted() })).status).toBe(204);
    expect((await fetch(`${url}/trpc/sessions.stop`, { method: "POST", headers: trusted(), body: "{}" })).status).toBe(401);
    expect((await fetch(`${url}/auth/check`, { headers: { ...trusted(), origin: "https://evil.example.test" } })).status).toBe(401);
  });

  it("authenticates upgraded connections and closes them at the identity recheck deadline", async () => {
    const url = await fixture(true);
    for (const headers of [
      { origin: config.publicOrigin },
      { ...trusted(), origin: "https://evil.example.test" }, trusted(),
    ]) expect(await rejectedSocket(url, headers)).toBe(401);
    const socket = new WebSocket(url.replace("http", "ws") + "/trpc", { headers: { ...trusted(), origin: config.publicOrigin } });
    const closed = new Promise<number>((resolve, reject) => { socket.once("close", (code) => resolve(code)); socket.once("error", reject); });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    expect(await closed).toBe(4401);
  });
});
