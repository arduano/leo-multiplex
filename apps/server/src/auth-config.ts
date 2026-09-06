import { isAbsolute, resolve } from "node:path";
import type { AccessConfig, AuthenticationConfig } from "./auth.js";

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export async function authenticationConfig(environment: NodeJS.ProcessEnv): Promise<AuthenticationConfig> {
  const mode = environment.LEO_AUTH_MODE ?? "cloudflare";
  const publicOrigin = required(environment, "LEO_PUBLIC_ORIGIN");
  const email = required(environment, "LEO_ACCESS_EMAIL");
  if (mode === "tailscale") {
    httpBindAddress(environment, { mode });
    return { mode, publicOrigin, email };
  }
  if (mode !== "cloudflare") throw new Error("LEO_AUTH_MODE must be cloudflare or tailscale");
  return {
    mode, publicOrigin, email,
    teamDomain: required(environment, "LEO_ACCESS_TEAM_DOMAIN"),
    audience: required(environment, "LEO_ACCESS_AUDIENCE"),
  };
}

/** An optional public edge has its own fixed authentication and exact origin. */
export function cloudflareSocketConfig(environment: NodeJS.ProcessEnv): { socketPath: string; access: AccessConfig } | undefined {
  const socketPath = environment.LEO_CLOUDFLARE_SOCKET;
  if (socketPath === undefined) {
    if (environment.LEO_CLOUDFLARE_PUBLIC_ORIGIN !== undefined) throw new Error("LEO_CLOUDFLARE_SOCKET is required with LEO_CLOUDFLARE_PUBLIC_ORIGIN");
    return undefined;
  }
  if (environment.LEO_AUTH_MODE !== "tailscale") throw new Error("The additional Cloudflare socket requires the primary Tailscale listener");
  assertSocketPath(socketPath);
  return {
    socketPath,
    access: {
      mode: "cloudflare",
      publicOrigin: required(environment, "LEO_CLOUDFLARE_PUBLIC_ORIGIN"),
      teamDomain: required(environment, "LEO_ACCESS_TEAM_DOMAIN"),
      audience: required(environment, "LEO_ACCESS_AUDIENCE"),
      email: required(environment, "LEO_ACCESS_EMAIL"),
    },
  };
}

export function assertSocketPath(socketPath: string): void {
  // Linux sockaddr_un reserves one byte of its 108-byte path for NUL.
  if (!isAbsolute(socketPath) || resolve(socketPath) !== socketPath || socketPath.includes("\0") || Buffer.byteLength(socketPath) > 107) {
    throw new Error("Cloudflare socket requires a canonical absolute path of at most 107 bytes");
  }
}

export function httpBindAddress(environment: NodeJS.ProcessEnv, config: Pick<AuthenticationConfig, "mode">): string {
  const address = environment.LEO_HTTP_BIND ?? (config.mode === "tailscale" ? "127.0.0.1" : "0.0.0.0");
  if (config.mode === "tailscale" && address !== "127.0.0.1" && address !== "::1") {
    throw new Error("Tailscale authentication requires an explicit loopback LEO_HTTP_BIND (127.0.0.1 or ::1)");
  }
  return address;
}
