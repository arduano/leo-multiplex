import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { sessionIdSchema } from "@arduano/agent-multiplex-protocol";
import { z } from "zod";
import type { AuthenticationConfig } from "./auth.js";
import { MobileNotifications, mobileDeviceInputSchema, mobileStorageScope } from "./mobile-notifications.js";

/** Authentication and exact-origin validation have already run on the shared
 * HTTP edge; this router never has a second, less restrictive identity path. */
export async function serveMobileRequest(request: IncomingMessage, response: ServerResponse, path: string,
  projection: AccessGatewayProjection, instanceId: string, access: AuthenticationConfig, mobile?: MobileNotifications): Promise<void> {
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body) + "\n");
  };
  if (path === "/api/mobile/config" && request.method === "GET") {
    send(200, mobile?.config(instanceId, access.email, access.publicOrigin) ?? {
      enabled: false, publicKey: "", origin: access.publicOrigin, storageScope: mobileStorageScope(instanceId, access.email),
    }); return;
  }
  if (!mobile) { send(503, { error: "Mobile notifications are unavailable" }); return; }
  try {
    if (path === "/api/mobile/state" && request.method === "GET") { send(200, mobile.state()); return; }
    if (path === "/api/mobile/activity" && request.method === "GET") { send(200, mobile.activity()); return; }
    const deviceMatch = /^\/api\/mobile\/devices\/([0-9a-f-]{36})(\/test)?$/.exec(path);
    if (deviceMatch) {
      const id = z.uuid().parse(deviceMatch[1]);
      if (deviceMatch[2] && request.method === "POST") { mobile.test(id); send(200, { ok: true }); return; }
      if (!deviceMatch[2] && request.method === "DELETE") { mobile.deleteDevice(id); send(200, { ok: true }); return; }
      if (!deviceMatch[2] && request.method === "PUT") {
        const input = mobileDeviceInputSchema.parse(await readJson(request));
        if (!mobile.config(instanceId, access.email, access.publicOrigin).enabled) { send(400, { error: "Register this device from the HTTPS workspace" }); return; }
        send(200, mobile.putDevice(id, input)); return;
      }
    }
    const watchMatch = /^\/api\/mobile\/watches\/([^/]+)$/.exec(path);
    if (watchMatch && request.method === "PUT") {
      const id = sessionIdSchema.parse(decodeURIComponent(watchMatch[1]!));
      const { watched } = z.object({ watched: z.boolean() }).strict().parse(await readJson(request));
      const session = watched ? await projection.getSession(id) : null;
      if (watched && !session) { send(404, { error: "Agent is unavailable" }); return; }
      send(200, { watchedSessionIds: mobile.setWatch(id, watched, session ?? undefined, projection.listInteractions()) }); return;
    }
    send(404, { error: "Mobile route not found" });
  } catch (error) {
    // Parse and provider exceptions may carry endpoints or keys. Never return
    // them to logs/responses, including Zod's input-bearing diagnostic details.
    send(error instanceof BodyLimitError ? 413 : 400, { error: error instanceof BodyLimitError ? "Request is too large" : "Invalid mobile request" });
  }
}
class BodyLimitError extends Error {}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new TypeError("JSON required");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 8_192) throw new BodyLimitError();
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
