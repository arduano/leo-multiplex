import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { GatewayAuthContext } from "@arduano/agent-multiplex-gateway";

export const OPERATOR_SCOPES = ["read", "agent-launch", "agent-archive", "agent-control", "terminal-view", "terminal-control", "metadata-propose"] as const;

export interface AccessConfig {
  readonly publicOrigin: string;
  readonly teamDomain: string;
  readonly audience: string;
  readonly email: string;
}
export interface AccessIdentity {
  readonly context: GatewayAuthContext;
  readonly expiresAt: number;
}

export class AuthenticationError extends Error {
  constructor() { super("Sign in with Cloudflare Access to open this workspace"); }
}

/** Request identity never comes from unsigned forwarding/email headers. */
export function createAccessAuthenticator(config: AccessConfig, testKeys?: JWTVerifyGetKey) {
  const origin = new URL(config.publicOrigin);
  const team = new URL(config.teamDomain);
  if (origin.protocol !== "https:" || origin.origin !== config.publicOrigin ||
      team.protocol !== "https:" || !team.hostname.endsWith(".cloudflareaccess.com") ||
      team.origin !== config.teamDomain || !config.audience.trim() || !config.email.includes("@")) {
    throw new TypeError("Access requires an HTTPS public origin, Cloudflare team origin, application audience, and owner email");
  }
  const keys = testKeys ?? createRemoteJWKSet(new URL("/cdn-cgi/access/certs", team), {
    timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
  });
  const owner = config.email.trim().toLowerCase();
  return async (request: IncomingMessage, websocket = false): Promise<AccessIdentity> => {
    if ((websocket || !["GET", "HEAD"].includes(request.method ?? "")) &&
        request.headers.origin !== origin.origin) throw new AuthenticationError();
    if (request.headers.origin !== undefined && request.headers.origin !== origin.origin) throw new AuthenticationError();
    const assertions = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === "cf-access-jwt-assertion");
    const token = request.headers["cf-access-jwt-assertion"];
    if (assertions.length !== 1 || typeof token !== "string" || token.length > 16_384) throw new AuthenticationError();
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"], issuer: team.origin, audience: config.audience,
        requiredClaims: ["exp", "iat", "sub", "email"],
      });
      if (typeof payload.email !== "string" || payload.email.toLowerCase() !== owner ||
          typeof payload.sub !== "string" || !payload.sub || typeof payload.exp !== "number") throw new AuthenticationError();
      return {
        context: { gatewayAccess: { authentication: "external", subject: payload.sub, scopes: OPERATOR_SCOPES } },
        expiresAt: payload.exp * 1_000,
      };
    } catch { throw new AuthenticationError(); }
  };
}
