import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { authenticationConfig, httpBindAddress } from "../apps/server/src/auth-config.js";
import {
  createAccessAuthenticator, createAuthenticator, createTailscaleAuthenticator, OPERATOR_SCOPES,
  TAILSCALE_IDENTITY_LIFETIME_MS,
} from "../apps/server/src/auth.js";

const config = { mode: "tailscale" as const, publicOrigin: "https://nas.fixture.ts.net", email: "owner@example.test" };
const authenticate = createTailscaleAuthenticator(config);
function request(headers: Record<string, string> = {}, method = "GET", remoteAddress: string | undefined = "127.0.0.1"): IncomingMessage {
  return { method, headers, rawHeaders: Object.entries(headers).flat(), socket: { remoteAddress } } as unknown as IncomingMessage;
}
const trusted = () => ({ "tailscale-user-login": config.email });

describe("Tailscale Serve identity", () => {
  it("requires the allowed Serve login and grants only operator scopes", async () => {
    for (const headers of [
      {},
      { ...trusted(), "tailscale-user-login": "someone@example.test" },
      { ...trusted(), "tailscale-user-login": "" },
      { ...trusted(), "tailscale-user-login": `${config.email}, someone@example.test` },
    ]) await expect(authenticate(request(headers))).rejects.toThrow("Sign in");
    const before = Date.now();
    const identity = await authenticate(request(trusted()));
    expect(identity.context.gatewayAccess).toEqual({ authentication: "external", subject: `tailscale:${config.email}`, scopes: OPERATOR_SCOPES });
    expect(identity.expiresAt).toBeGreaterThanOrEqual(before + TAILSCALE_IDENTITY_LIFETIME_MS);
    expect(identity.expiresAt).toBeLessThanOrEqual(Date.now() + TAILSCALE_IDENTITY_LIFETIME_MS);
    expect(identity.context.gatewayAccess.scopes).not.toContain("authority-admin");
  });

  it("rejects direct LAN, tailnet, Docker and forwarded loopback claims", async () => {
    for (const remote of ["192.168.1.20", "100.64.0.10", "172.17.0.2", "::ffff:192.168.1.20", "localhost", ""]) {
      const input = request({ ...trusted(), "x-forwarded-for": "127.0.0.1", "x-real-ip": "::1" }, "GET", remote);
      await expect(authenticate(input)).rejects.toThrow("Sign in");
    }
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      await expect(authenticate(request(trusted(), "GET", remote))).resolves.toBeDefined();
    }
    const input = request(trusted());
    Object.assign(input, { socket: {} });
    await expect(authenticate(input)).rejects.toThrow("Sign in");
  });

  it("rejects duplicate identity and origin headers", async () => {
    for (const name of ["tailscale-user-login", "origin"]) {
      const input = request({ ...trusted(), origin: config.publicOrigin });
      input.rawHeaders.push(name.toUpperCase(), String(input.headers[name]));
      await expect(authenticate(input)).rejects.toThrow("Sign in");
    }
  });

  it("requires the exact origin on mutations and WebSocket upgrades", async () => {
    for (const origin of [undefined, "https://evil.example.test", `${config.publicOrigin}/`, "null"]) {
      const headers = { ...trusted(), ...(origin === undefined ? {} : { origin }) };
      await expect(authenticate(request(headers, "POST"))).rejects.toThrow("Sign in");
      await expect(authenticate(request(headers), true)).rejects.toThrow("Sign in");
    }
    await expect(authenticate(request({ ...trusted(), origin: config.publicOrigin }, "POST"))).resolves.toBeDefined();
    await expect(authenticate(request({ ...trusted(), origin: config.publicOrigin }), true)).resolves.toBeDefined();
    await expect(authenticate(request({ ...trusted(), origin: "https://evil.example.test" }))).rejects.toThrow("Sign in");
  });

  it("does not use Cloudflare or arbitrary forwarded identity as a Tailscale fallback", async () => {
    await expect(authenticate(request({ "cf-access-jwt-assertion": "fixture", "cf-access-authenticated-user-email": config.email, "x-forwarded-for": "100.64.0.1" }))).rejects.toThrow("Sign in");
    await expect(createAuthenticator(config)(request(trusted()))).resolves.toBeDefined();
  });

  it("rejects insecure origin and ambiguous owner configuration", () => {
    for (const override of [{ publicOrigin: "http://nas.fixture.ts.net" }, { email: "owner@example.test,other@example.test" }, { email: "\u00e9@example.test" }]) {
      expect(() => createTailscaleAuthenticator({ ...config, ...override })).toThrow("Tailscale requires");
    }
  });

  it.each(["http://100.64.0.0", "http://100.127.255.255", "http://100.100.20.30:8080"])("accepts canonical tailnet HTTP origin %s with the same identity and exact-origin fences", async (publicOrigin) => {
    const auth = createTailscaleAuthenticator({ ...config, publicOrigin });
    await expect(auth(request(trusted()))).resolves.toBeDefined();
    await expect(auth(request({ ...trusted(), origin: publicOrigin }, "POST"))).resolves.toBeDefined();
    await expect(auth(request({ ...trusted(), origin: publicOrigin }), true)).resolves.toBeDefined();
    await expect(auth(request({ origin: publicOrigin }, "POST"))).rejects.toThrow("Sign in");
    await expect(auth(request({ ...trusted(), origin: publicOrigin }, "POST", "100.64.0.2"))).rejects.toThrow("Sign in");
    for (const origin of [undefined, publicOrigin.replace("http:", "https:"), `${publicOrigin}/`, "http://100.64.0.3:8080"]) {
      const headers = { ...trusted(), ...(origin === undefined ? {} : { origin }) };
      await expect(auth(request(headers, "POST"))).rejects.toThrow("Sign in");
      await expect(auth(request(headers), true)).rejects.toThrow("Sign in");
    }
  });

  it.each([
    "http://100.63.255.255", "http://100.128.0.0", "http://99.127.0.1", "http://101.64.0.1",
    "http://192.168.1.10", "http://10.0.0.1", "http://172.16.0.1", "http://127.0.0.1", "http://8.8.8.8",
    "http://localhost", "http://nas.fixture.ts.net", "http://100.64.0.1.example.test", "http://[::1]", "http://[::ffff:100.64.0.1]",
    "http://user@100.64.0.1", "http://user:pass@100.64.0.1", "http://100.64.0.1/", "http://100.64.0.1/path",
    "http://100.64.0.1?query=value", "http://100.64.0.1#fragment", "http://100.64.0.1:80", "http://100.64.0.1:08080",
    "http://100.64.1", "http://1681915905", "http://0x64400001", "http://0144.0100.0.1", "http://100.064.0.1", "http://100.64.0.1.",
    "http://%31%30%30.64.0.1", " http://100.64.0.1", "http://100.64.0.1\n", "ftp://100.64.0.1",
  ])("rejects unapproved or noncanonical HTTP origin %s", (publicOrigin) => {
    expect(() => createTailscaleAuthenticator({ ...config, publicOrigin })).toThrow();
  });

  it("keeps Cloudflare origins HTTPS-only even for a Tailscale address", () => {
    expect(() => createAccessAuthenticator({ publicOrigin: "http://100.64.0.1", teamDomain: "https://fixture.cloudflareaccess.com", audience: "fixture", email: config.email })).toThrow("HTTPS");
  });

  it("loads only explicitly selected authentication config and never falls back when it is incomplete", async () => {
    const environment = { LEO_AUTH_MODE: "tailscale", LEO_PUBLIC_ORIGIN: config.publicOrigin, LEO_ACCESS_EMAIL: config.email };
    expect(await authenticationConfig(environment)).toEqual(config);
    for (const bind of ["0.0.0.0", "::", "localhost", "192.168.1.20", "100.64.0.10"]) {
      await expect(authenticationConfig({ ...environment, LEO_HTTP_BIND: bind })).rejects.toThrow("explicit loopback");
    }
    expect(httpBindAddress(environment, config)).toBe("127.0.0.1");
    expect(httpBindAddress({ ...environment, LEO_HTTP_BIND: "::1" }, config)).toBe("::1");
    await expect(authenticationConfig({ ...environment, LEO_AUTH_MODE: "none" })).rejects.toThrow("must be cloudflare or tailscale");
    await expect(authenticationConfig({ LEO_PUBLIC_ORIGIN: config.publicOrigin, LEO_ACCESS_EMAIL: config.email })).rejects.toThrow("LEO_ACCESS_TEAM_DOMAIN");
    expect(await authenticationConfig({ LEO_PUBLIC_ORIGIN: config.publicOrigin, LEO_ACCESS_EMAIL: config.email, LEO_ACCESS_TEAM_DOMAIN: "https://fixture.cloudflareaccess.com", LEO_ACCESS_AUDIENCE: "fixture-app" })).toMatchObject({ mode: "cloudflare", audience: "fixture-app" });
  });
});
