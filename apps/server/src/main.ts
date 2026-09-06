import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type GatewaySourceConfig } from "@arduano/agent-multiplex-gateway";
import { sourceIdSchema } from "@arduano/agent-multiplex-protocol";
import { OPERATOR_SCOPES, createAuthenticator } from "./auth.js";
import { authenticationConfig, cloudflareSocketConfig, httpBindAddress } from "./auth-config.js";
import { runPersonalGateway } from "./gateway.js";
import { openMobileNotifications } from "./mobile-notifications.js";
import { createPersonalHttpSurface } from "./http.js";

export async function runPersonalServer(environment: NodeJS.ProcessEnv, signal: AbortSignal) {
  const state = resolve(environment.LEO_GATEWAY_STATE_DIR ?? "/data");
  const access = await authenticationConfig(environment);
  const authenticate = createAuthenticator(access);
  const cloudflare = cloudflareSocketConfig(environment);
  const authenticateCloudflare = cloudflare === undefined ? undefined : createAuthenticator(cloudflare.access);
  const port = Number(environment.LEO_HTTP_PORT ?? "4318");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid LEO_HTTP_PORT");
  const bindAddress = httpBindAddress(environment, access);
  const pairing = JSON.parse(await readFile(required(environment, "LEO_PAIRING_FILE"), "utf8")) as Record<string, unknown>;
  if (pairing.version !== 1 || typeof pairing.sharedSecret !== "string" || pairing.sharedSecret.length < 32 ||
      !Array.isArray(pairing.sources) || pairing.sources.length === 0) throw new Error("Invalid host pairing file");
  const sources: GatewaySourceConfig[] = pairing.sources.map((source: Record<string, unknown>) => {
    const locator = source.locator as Record<string, unknown> | undefined;
    if (typeof source.endpointId !== "string" || !locator || locator.kind !== "ticket" || typeof locator.ticket !== "string") throw new Error("Invalid host pairing source");
    return {
      sourceId: sourceIdSchema.parse(source.sourceId), displayName: String(source.displayName ?? source.sourceId),
      endpointId: source.endpointId, locator: { kind: "ticket", ticket: locator.ticket },
      priority: 0, enabled: true, requestedScopes: OPERATOR_SCOPES,
    };
  });
  await mkdir(state, { recursive: true, mode: 0o700 });
  const mobile = await openMobileNotifications(state, cloudflare?.access.publicOrigin ?? access.publicOrigin, access.email);
  try {
    await runPersonalGateway({
      sharedSecret: pairing.sharedSecret, identityPath: join(state, "gateway.identity"),
      statePath: join(state, "gateway.sqlite"), sources,
      ...(environment.LEO_GATEWAY_P2P_BIND === undefined ? {} : { p2pBindAddress: environment.LEO_GATEWAY_P2P_BIND }),
      bindAddress, port, reconnectMaxMs: 30_000,
    }, signal, { mobileNotifications: mobile, httpSurface: { authentication: "external", create: (projection, instanceId) =>
      createPersonalHttpSurface(projection, instanceId, access, authenticate, mobile) },
      ...(cloudflare === undefined ? {} : { additionalHttpSurfaces: [{
        socketPath: cloudflare.socketPath,
        httpSurface: { authentication: "external", create: (projection, instanceId) =>
          createPersonalHttpSurface(projection, instanceId, cloudflare.access, authenticateCloudflare, mobile) },
      }] }),
    });
  } finally { await mobile.close(); }
}

function required(environment: NodeJS.ProcessEnv, key: string) {
  const value = environment[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await runPersonalServer(process.env, controller.signal).catch(() => {
    console.error("Leo gateway failed; check local configuration and file permissions");
    process.exitCode = 1;
  });
}
