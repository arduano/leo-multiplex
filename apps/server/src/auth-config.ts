import type { AuthenticationConfig } from "./auth.js";

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

export function httpBindAddress(environment: NodeJS.ProcessEnv, config: Pick<AuthenticationConfig, "mode">): string {
  const address = environment.LEO_HTTP_BIND ?? (config.mode === "tailscale" ? "127.0.0.1" : "0.0.0.0");
  if (config.mode === "tailscale" && address !== "127.0.0.1" && address !== "::1") {
    throw new Error("Tailscale authentication requires an explicit loopback LEO_HTTP_BIND (127.0.0.1 or ::1)");
  }
  return address;
}
