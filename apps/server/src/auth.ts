import type { IncomingMessage } from "node:http";
import { isIPv4 } from "node:net";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { GatewayAuthContext } from "@arduano/agent-multiplex-gateway";

export const OPERATOR_SCOPES = ["read", "agent-launch", "agent-archive", "agent-control", "terminal-view", "terminal-control", "metadata-propose"] as const;

export interface AccessConfig {
  readonly mode?: "cloudflare";
  readonly publicOrigin: string;
  readonly teamDomain: string;
  readonly audience: string;
  readonly email: string;
}
export interface TailscaleConfig {
  readonly mode: "tailscale";
  readonly publicOrigin: string;
  readonly email: string;
}
export type AuthenticationConfig = AccessConfig | TailscaleConfig;
export const TAILSCALE_IDENTITY_LIFETIME_MS = 5 * 60_000;
export interface AccessIdentity {
  readonly context: GatewayAuthContext;
  readonly expiresAt: number;
}

export class AuthenticationError extends Error {
  constructor() { super("Sign in through the configured workspace address"); }
}

function assertOrigin(request: IncomingMessage, origin: string, websocket: boolean): void {
  const supplied = request.headers.origin;
  if ((websocket || !["GET", "HEAD"].includes(request.method ?? "")) && supplied !== origin) throw new AuthenticationError();
  if (supplied !== undefined && supplied !== origin) throw new AuthenticationError();
  const count = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === "origin").length;
  if (count > 1) throw new AuthenticationError();
}

function singleHeader(request: IncomingMessage, name: string, limit: number): string {
  const count = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === name).length;
  const value = request.headers[name];
  if (count !== 1 || typeof value !== "string" || !value || value.length > limit) throw new AuthenticationError();
  return value;
}

function isTailscaleHttpOrigin(origin: URL): boolean {
  if (origin.protocol !== "http:" || !isIPv4(origin.hostname)) return false;
  const [first, second] = origin.hostname.split(".").map(Number);
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

/** Serve replaces identity headers. Only NAS-local socket peers may assert this identity. */
export function createTailscaleAuthenticator(config: TailscaleConfig) {
  const origin = new URL(config.publicOrigin);
  const owner = config.email.trim().toLowerCase();
  // Exact serialization rejects URL credentials/components and noncanonical IPv4
  // spellings normalized by URL (integer, hexadecimal, octal, or shortened forms).
  if ((origin.protocol !== "https:" && !isTailscaleHttpOrigin(origin)) || origin.origin !== config.publicOrigin ||
      !/^[\x21-\x7e]+$/.test(owner) || !/^[^\s,@]+@[^\s,@]+$/.test(owner)) {
    throw new TypeError("Tailscale requires an HTTPS origin or canonical HTTP IPv4 origin in 100.64.0.0/10, and owner email");
  }
  return async (request: IncomingMessage, websocket = false): Promise<AccessIdentity> => {
    assertOrigin(request, origin.origin, websocket);
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress ?? "")) throw new AuthenticationError();
    const login = singleHeader(request, "tailscale-user-login", 320);
    if (login.toLowerCase() !== owner) throw new AuthenticationError();
    return {
      context: { gatewayAccess: { authentication: "external", subject: `tailscale:${owner}`, scopes: OPERATOR_SCOPES } },
      // Serve identity has no JWT expiry. Periodic reconnect forces a fresh
      // authenticated Serve request and bounds existing upgraded connections.
      expiresAt: Date.now() + TAILSCALE_IDENTITY_LIFETIME_MS,
    };
  };
}

export function createAuthenticator(config: AuthenticationConfig) {
  return config.mode === "tailscale" ? createTailscaleAuthenticator(config) : createAccessAuthenticator(config);
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
    assertOrigin(request, origin.origin, websocket);
    const token = singleHeader(request, "cf-access-jwt-assertion", 16_384);
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
