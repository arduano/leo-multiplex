// Adapted from Agent Multiplex's MIT-licensed reference gateway composition.
// Copyright (c) 2026 Arduano. See THIRD_PARTY_NOTICES.md and LICENSE.
// Domain authority, routing and transport remain in the published packages.
import { advanceAccessCursor } from "@arduano/agent-multiplex-client";
import { P2PControlNodeSourceClient, createP2PAccessGatewayNode, type P2PAccessGatewayNodeHandle } from "@arduano/agent-multiplex-client-p2prpc";
import { AccessGatewayProjection, GatewayOperationalStore, type GatewaySourceDefinition } from "@arduano/agent-multiplex-gateway-core";
import { loadOrCreateGatewaySecretKey, type GatewayAppConfig, type GatewayComposition, type GatewayHttpSurface } from "@arduano/agent-multiplex-gateway";
import type { SourceId, StreamCursor } from "@arduano/agent-multiplex-protocol";
import type { PinnedPeerTarget } from "@arduano/agent-multiplex-transport-p2prpc";
import type { GatewaySourceConfig } from "@arduano/agent-multiplex-gateway";

export async function runPersonalGateway(
  config: GatewayAppConfig & { readonly p2pBindAddress?: string },
  signal: AbortSignal,
  composition: GatewayComposition = {},
): Promise<void> {
  if (composition.httpSurface?.authentication !== "external" ||
    typeof composition.httpSurface.create !== "function" || config.auth !== undefined) {
    throw new TypeError("a custom gateway edge requires explicit external authentication and cannot combine bearer configuration");
  }
  if (signal.aborted) return;
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  const callerSignal = signal;
  signal = lifetime.signal;
  const secretKey = await loadOrCreateGatewaySecretKey(config.identityPath);
  const store = new GatewayOperationalStore(config.statePath);
  const persisted = new Map(store.listSources().map((source) => [source.sourceId, source]));
  let p2p: P2PAccessGatewayNodeHandle | undefined;
  let http: GatewayHttpSurface | undefined;
  const supervisors: Promise<void>[] = [];
  const closeTransport = (): void => {
    void p2p?.close().catch((error: unknown) => logError("closing p2prpc", error));
  };
  signal.addEventListener("abort", closeTransport, { once: true });
  callerSignal.addEventListener("abort", stop, { once: true });
  if (callerSignal.aborted) lifetime.abort();

  try {
    p2p = await createP2PAccessGatewayNode({
      sources: config.sources.map((source) => {
        const preferred = preferredLocator(
          source,
          persisted.get(source.sourceId),
        );
        return {
          sourceId: source.sourceId,
          name: `agent-multiplex-access-gateway:${source.sourceId}`,
          requestedScopes: source.requestedScopes,
          target: {
            endpointId: source.endpointId,
            locator: preferred,
          },
          // A persisted renewal is a reachability optimization, not the only
          // route to the pinned control-node identity. Keep provisioned
          // bootstrap reachability available when that renewal expires.
          ...(preferred === source.locator
            ? {}
            : { fallbackLocator: source.locator }),
        };
      }),
      sharedSecret: {
        secret: config.sharedSecret,
        sessionTtlMs: 60 * 60_000,
      },
      iroh: {
        secretKey,
        ...(config.p2pBindAddress === undefined ? {} : { bindAddress: config.p2pBindAddress }),
        relay: { mode: "default" },
        allowDirectAddress: () => true,
        allowRelayUrl: () => true,
      },
      onError: (error) => logError("p2prpc", error),
    });

    if (signal.aborted) return;
    const clients = new Map<SourceId, P2PControlNodeSourceClient>();
    const renewedTickets = new Map<SourceId, string>();
    const definitions: GatewaySourceDefinition[] = config.sources.map((source) => {
      const handle = p2p!.sources.get(source.sourceId);
      if (!handle) throw new Error(`p2prpc source ${source.sourceId} was not created`);
      const client = new P2PControlNodeSourceClient(handle, (ticket) => {
        renewedTickets.set(source.sourceId, ticket);
      });
      clients.set(source.sourceId, client);
      return {
        sourceId: source.sourceId,
        displayName: source.displayName,
        endpointId: source.endpointId,
        priority: source.priority,
        enabled: source.enabled,
        client,
      };
    });
    const projection = new AccessGatewayProjection(definitions);

    // The HTTP edge remains useful when all sources are temporarily offline.
    await Promise.allSettled(config.sources
      .filter((source) => source.enabled)
      .map((source) => projection.refreshSource(source.sourceId)));

    if (signal.aborted) return;
    http = composition.httpSurface.create(projection, p2p.localEndpointId);
    await listen(http.server, config.port, config.bindAddress);
    const address = http.server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    console.log("Agent Multiplex access gateway");
    console.log(`Sources:          ${config.sources.length}`);
    console.log(`Dashboard:        http://${config.bindAddress}:${port}`);
    console.log(`tRPC:             http://${config.bindAddress}:${port}/trpc`);

    for (const source of config.sources) {
      persistSource(
        store,
        source,
        projection,
        renewedTickets.get(source.sourceId) ??
          persisted.get(source.sourceId)?.renewedTicket,
      );
      if (!source.enabled) continue;
      supervisors.push(superviseSource(
        source,
        clients.get(source.sourceId)!,
        projection,
        store,
        renewedTickets,
        config.reconnectMaxMs,
        signal,
      ));
    }
    await aborted(signal);
  } finally {
    lifetime.abort();
    callerSignal.removeEventListener("abort", stop);
    signal.removeEventListener("abort", closeTransport);
    await http?.close().catch((error: unknown) => logError("closing HTTP edge", error));
    await p2p?.close().catch((error: unknown) => logError("closing p2prpc", error));
    await Promise.allSettled(supervisors);
    store.close();
  }
}

async function superviseSource(
  source: GatewaySourceConfig,
  client: P2PControlNodeSourceClient,
  projection: AccessGatewayProjection,
  store: GatewayOperationalStore,
  renewedTickets: ReadonlyMap<SourceId, string>,
  reconnectMaxMs: number,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await projection.refreshSource(source.sourceId);
      const diagnostic = projection.diagnostics().find(
        (candidate) => candidate.sourceId === source.sourceId,
      );
      const manifest = diagnostic?.manifest;
      if (!manifest) throw new Error("source synchronized without a manifest");
      let cursor: StreamCursor = {
        feedId: manifest.feedId,
        controlCursor: manifest.controlCursor,
        native: {},
      };
      persistSource(
        store,
        source,
        projection,
        renewedTickets.get(source.sourceId),
        cursor,
      );
      attempt = 0;
      let resynchronize = false;
      for await (const item of client.watch(cursor, signal)) {
        if (item.kind === "streamReset") {
          // The gateway never invents missing control-node history.
          resynchronize = true;
          break;
        }
        projection.ingest(source.sourceId, item);
        cursor = advanceAccessCursor(cursor, item);
        // Native output can be extremely chatty and remains app-server-owned;
        // do not force a FULL-sync SQLite write for every token/chunk.
        if (item.kind === "control" || item.kind === "heartbeat") {
          persistSource(
            store,
            source,
            projection,
            renewedTickets.get(source.sourceId),
            cursor,
          );
        }
        if (
          item.kind === "control" &&
          (item.change.type === "controlNode.attached" ||
            item.change.type === "controlNode.detached" ||
            item.change.type === "authority.promoted")
        ) {
          resynchronize = true;
          break;
        }
      }
      if (resynchronize) continue;
      if (!signal.aborted) throw new Error("control-node source requested resynchronization");
    } catch (error) {
      if (signal.aborted) return;
      projection.markUnavailable(source.sourceId, error);
      persistSource(
        store,
        source,
        projection,
        renewedTickets.get(source.sourceId),
      );
      const delayMs = reconnectDelay(attempt++, reconnectMaxMs);
      logError(`source ${source.sourceId} unavailable; retrying in ${delayMs}ms`, error);
      await abortableDelay(delayMs, signal);
      if (!signal.aborted) await client.reconnect().catch(() => undefined);
    }
  }
}

function persistSource(
  store: GatewayOperationalStore,
  source: GatewaySourceConfig,
  projection: AccessGatewayProjection,
  renewedTicket?: string,
  cursor?: Pick<StreamCursor, "feedId" | "controlCursor">,
): void {
  const diagnostic = projection.diagnostics().find(
    (candidate) => candidate.sourceId === source.sourceId,
  );
  store.putSource({
    sourceId: source.sourceId,
    displayName: source.displayName,
    endpointId: source.endpointId,
    locator: source.locator as Readonly<Record<string, unknown>>,
    priority: source.priority,
    enabled: source.enabled,
    ...(renewedTicket === undefined ? {} : { renewedTicket }),
    ...(cursor?.feedId === undefined ? {} : { feedId: cursor.feedId }),
    controlCursor: cursor?.controlCursor ?? diagnostic?.manifest?.controlCursor ?? 0,
    ...(diagnostic === undefined ? {} : { health: diagnostic }),
    updatedAt: new Date().toISOString(),
  });
}

function preferredLocator(
  configured: GatewaySourceConfig,
  persisted: ReturnType<GatewayOperationalStore["listSources"]>[number] | undefined,
): PinnedPeerTarget["locator"] {
  if (persisted?.endpointId === configured.endpointId && persisted.renewedTicket) {
    return { kind: "ticket", ticket: persisted.renewedTicket };
  }
  return configured.locator;
}

function listen(
  server: import("node:http").Server,
  port: number,
  bindAddress: string,
): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindAddress);
  });
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveAbort) => {
    signal.addEventListener("abort", () => resolveAbort(), { once: true });
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveDelay();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function reconnectDelay(attempt: number, maximum: number): number {
  return Math.min(maximum, 250 * 2 ** Math.min(attempt, 16));
}

// Transport failures may embed locator or peer details. Keep diagnostics bounded.
function logError(label: string, _error: unknown): void {
  console.error(`${label}: connection unavailable`);
}
