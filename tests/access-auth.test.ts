import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import type { IncomingMessage } from "node:http";
import { createAccessAuthenticator, OPERATOR_SCOPES } from "../apps/server/src/auth.js";

const config = { publicOrigin: "https://agents.example.test", teamDomain: "https://leo-test.cloudflareaccess.com", audience: "test-app", email: "owner@example.test" };
let key: CryptoKey;
let authenticate: ReturnType<typeof createAccessAuthenticator>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256"); key = pair.privateKey;
  const publicKey = await exportJWK(pair.publicKey);
  authenticate = createAccessAuthenticator(config, createLocalJWKSet({ keys: [{ ...publicKey, kid: "test", alg: "RS256" }] }));
});
async function token(fields: Record<string, unknown> = {}) {
  return new SignJWT({ email: config.email, ...fields }).setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(config.teamDomain).setAudience(config.audience).setSubject("test-owner").setIssuedAt()
    .setExpirationTime("5m").sign(key);
}
function request(jwt?: string, method = "GET", origin?: string): IncomingMessage {
  return { method, headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...(origin ? { origin } : {}) },
    rawHeaders: jwt ? ["Cf-Access-Jwt-Assertion", jwt] : [] } as unknown as IncomingMessage;
}
describe("Access identity", () => {
  it("accepts the owner and grants operator scopes without administration", async () => {
    const value = await authenticate(request(await token()));
    expect(value.context.gatewayAccess.subject).toBe("test-owner");
    expect(value.context.gatewayAccess.scopes).toEqual(OPERATOR_SCOPES);
    expect(value.context.gatewayAccess.scopes).not.toContain("authority-admin");
  });
  it("requires signed assertions rather than claimed email headers", async () => {
    const input = request(); input.headers["cf-access-authenticated-user-email"] = config.email;
    await expect(authenticate(input)).rejects.toThrow("Sign in");
    await expect(authenticate(request("forged"))).rejects.toThrow("Sign in");
  });
  it("rejects another authenticated identity and duplicate assertion headers", async () => {
    await expect(authenticate(request(await token({ email: "someone@example.test" })))).rejects.toThrow("Sign in");
    const input = request(await token()); input.rawHeaders.push(...input.rawHeaders);
    await expect(authenticate(input)).rejects.toThrow("Sign in");
  });
  it("requires the exact browser origin for mutations and websocket handshakes", async () => {
    const jwt = await token();
    for (const origin of [undefined, "https://evil.example.test"]) {
      await expect(authenticate(request(jwt, "POST", origin))).rejects.toThrow("Sign in");
      await expect(authenticate(request(jwt, "GET", origin), true)).rejects.toThrow("Sign in");
    }
    await expect(authenticate(request(jwt, "POST", config.publicOrigin))).resolves.toBeDefined();
    await expect(authenticate(request(jwt, "GET", config.publicOrigin), true)).resolves.toBeDefined();
  });
  it("rejects expired tokens, another application, and another issuer", async () => {
    for (const fields of [{ exp: 1 }, { aud: "another-app" }, { iss: "https://other.cloudflareaccess.com" }]) {
      const jwt = await new SignJWT({ email: config.email, sub: "owner", iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60, aud: config.audience, iss: config.teamDomain, ...fields })
        .setProtectedHeader({ alg: "RS256", kid: "test" }).sign(key);
      await expect(authenticate(request(jwt))).rejects.toThrow("Sign in");
    }
  });
  it("refuses insecure origin configuration", () => {
    expect(() => createAccessAuthenticator({ ...config, publicOrigin: "http://agents.example.test" })).toThrow();
    expect(() => createAccessAuthenticator({ ...config, teamDomain: "https://untrusted.example.test" })).toThrow();
  });
});
