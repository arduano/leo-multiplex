import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import { createAccessGatewayRouter, type GatewayHttpSurface } from "@arduano/agent-multiplex-gateway";
import type { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import {
  webAsset, installBoundedWebSocketEgress, TRPC_HTTP_BODY_LIMIT_BYTES,
  WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES,
} from "../../web/src/index.js";
import { mobileStorageScope, type MobileNotifications } from "./mobile-notifications.js";
import { serveMobileRequest } from "./mobile-http.js";
import { AuthenticationError, createAuthenticator, type AuthenticationConfig, type AccessIdentity } from "./auth.js";

export function createPersonalHttpSurface(
  projection: AccessGatewayProjection,
  instanceId: string,
  access: AuthenticationConfig,
  authenticate = createAuthenticator(access),
  mobile?: MobileNotifications,
): GatewayHttpSurface {
  const router = createAccessGatewayRouter(projection, { instanceId });
  const identities = new WeakMap<IncomingMessage, AccessIdentity>();
  const handler = createHTTPHandler({
    router, basePath: "/trpc/", maxBodySize: TRPC_HTTP_BODY_LIMIT_BYTES,
    createContext: ({ req }) => {
      const identity = identities.get(req);
      if (!identity || identity.expiresAt <= Date.now()) throw new AuthenticationError();
      return identity.context;
    },
  });
  const server = createServer((request, response) => {
    const nonce = randomBytes(18).toString("base64url");
    securityHeaders(response, nonce);
    void serve(request, response, nonce).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Workspace request failed\n");
    });
  });
  async function serve(request: IncomingMessage, response: ServerResponse, nonce: string) {
    const path = new URL(request.url ?? "/", access.publicOrigin).pathname;
    // No source identities, authentication status, or catalog data in health checks.
    if (path === "/healthz" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"ok":true}\n'); return;
    }
    try { identities.set(request, await authenticate(request)); }
    catch {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(access.mode === "tailscale" ? "Connect through the configured Tailscale workspace address\n" : "Sign in with Cloudflare Access\n"); return;
    }
    if (path === "/auth/check") {
      response.writeHead(204, { "cache-control": "no-store" }); response.end(); return;
    }
    if (path === "/auth/session" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ method: access.mode ?? "cloudflare", storageScope: mobileStorageScope(instanceId, access.email) }) + "\n"); return;
    }
    if (path.startsWith("/api/mobile/")) { await serveMobileRequest(request, response, path, projection, instanceId, access, mobile); return; }
    if (path.startsWith("/trpc/")) { handler(request, response); return; }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405); response.end(); return;
    }
    const asset = webAsset(request.url ?? "/", { styleNonce: nonce });
    if (!asset) { response.writeHead(404); response.end("Not found\n"); return; }
    response.writeHead(200, { "content-type": asset.contentType, "cache-control": asset.cacheControl, "content-length": asset.body.byteLength });
    response.end(request.method === "HEAD" ? undefined : asset.body);
  }
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: WEBSOCKET_INGRESS_MESSAGE_LIMIT_BYTES });
  installBoundedWebSocketEgress(webSockets);
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      if (new URL(request.url ?? "/", access.publicOrigin).pathname !== "/trpc") throw new AuthenticationError();
      const identity = await authenticate(request, true);
      identities.set(request, identity);
      if (socket.destroyed) return;
      webSockets.handleUpgrade(request, socket, head, (websocket) => {
        const timer = setTimeout(() => websocket.close(4401, "Sign in again"), Math.min(2_147_483_647, Math.max(0, identity.expiresAt - Date.now())));
        timer.unref();
        websocket.once("close", () => clearTimeout(timer));
        webSockets.emit("connection", websocket, request);
      });
    })().catch(() => { if (!socket.destroyed) socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  });
  applyWSSHandler({
    wss: webSockets, router,
    createContext: ({ req }) => {
      const identity = identities.get(req);
      if (!identity || identity.expiresAt <= Date.now()) throw new AuthenticationError();
      return identity.context;
    },
    keepAlive: { enabled: true, pingMs: 15_000, pongWaitMs: 5_000 },
  });
  let closing: Promise<void> | undefined;
  return { server, webSockets, router, close() {
    return closing ??= (async () => {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    })();
  } };
}

function securityHeaders(response: ServerResponse, nonce: string) {
  response.setHeader("content-security-policy", `default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cache-control", "no-store");
}
