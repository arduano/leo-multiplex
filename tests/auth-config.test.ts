import { describe, expect, it } from "vitest";
import { authenticationConfig, cloudflareSocketConfig } from "../apps/server/src/auth-config.js";
import { createAuthenticator } from "../apps/server/src/auth.js";

const environment = {
  LEO_AUTH_MODE: "tailscale",
  LEO_PUBLIC_ORIGIN: "http://100.64.0.2:8444",
  LEO_ACCESS_EMAIL: "owner@example.test",
  LEO_CLOUDFLARE_SOCKET: "/run/leo-cloudflare/access.sock",
  LEO_CLOUDFLARE_PUBLIC_ORIGIN: "https://agents.example.test",
  LEO_ACCESS_TEAM_DOMAIN: "https://fixture.cloudflareaccess.com",
  LEO_ACCESS_AUDIENCE: "fixture-app",
};

describe("independently authenticated Cloudflare socket configuration", () => {
  it("preserves the primary Tailscale origin and fixes the second listener to Cloudflare", async () => {
    expect(await authenticationConfig(environment)).toEqual({
      mode: "tailscale", publicOrigin: environment.LEO_PUBLIC_ORIGIN, email: environment.LEO_ACCESS_EMAIL,
    });
    expect(cloudflareSocketConfig(environment)).toEqual({
      socketPath: environment.LEO_CLOUDFLARE_SOCKET,
      access: {
        mode: "cloudflare", publicOrigin: environment.LEO_CLOUDFLARE_PUBLIC_ORIGIN,
        teamDomain: environment.LEO_ACCESS_TEAM_DOMAIN, audience: environment.LEO_ACCESS_AUDIENCE,
        email: environment.LEO_ACCESS_EMAIL,
      },
    });
  });

  it("keeps existing single-listener deployments unchanged", () => {
    expect(cloudflareSocketConfig({})).toBeUndefined();
    expect(cloudflareSocketConfig({ LEO_AUTH_MODE: "cloudflare", LEO_PUBLIC_ORIGIN: "https://agents.example.test" })).toBeUndefined();
  });

  it.each([
    "LEO_CLOUDFLARE_SOCKET", "LEO_CLOUDFLARE_PUBLIC_ORIGIN", "LEO_ACCESS_TEAM_DOMAIN", "LEO_ACCESS_AUDIENCE", "LEO_ACCESS_EMAIL",
  ])("rejects incomplete optional configuration: %s", (key) => {
    const incomplete: NodeJS.ProcessEnv = { ...environment };
    delete incomplete[key];
    expect(() => cloudflareSocketConfig(incomplete)).toThrow(key);
  });

  it.each(["", "relative.sock", "/run/../run/access.sock", "/run/access.sock/", "/run/socket\0", `/${"x".repeat(107)}`])("rejects unsafe socket path %j", (path) => {
    expect(() => cloudflareSocketConfig({ ...environment, LEO_CLOUDFLARE_SOCKET: path })).toThrow("canonical absolute path");
  });

  it.each(["cloudflare", "none", undefined])("rejects an incompatible primary mode %s", (mode) => {
    expect(() => cloudflareSocketConfig({ ...environment, LEO_AUTH_MODE: mode })).toThrow("primary Tailscale");
  });

  it("validates the second origin before constructing a listener", () => {
    const config = cloudflareSocketConfig({ ...environment, LEO_CLOUDFLARE_PUBLIC_ORIGIN: "http://100.64.0.2" })!;
    expect(() => createAuthenticator(config.access)).toThrow("HTTPS");
  });
});
