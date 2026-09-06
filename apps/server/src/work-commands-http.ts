import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import { workCommandLookupSchema, workCommandSubmitSchema, type WorkCommandsPort } from "../../../packages/work-commands/src/contract.js";
import { WorkCommandTransportError } from "../../../packages/work-commands/src/transport.js";
import type { AccessIdentity } from "./auth.js";

// Includes worst-case JSON escaping of the bounded command and cwd strings.
const MAX_BODY_BYTES = 128 * 1_024;
const knownCodes = new Set(["BUSY", "CONFLICT", "REQUEST_CONFLICT", "RECOVERY_REQUIRED", "JOURNAL_FULL", "INVALID_INPUT", "INVALID_CWD", "CWD_NOT_ALLOWED", "OUTCOME_UNKNOWN", "CLOSED", "STATE_INVALID", "LIMIT_REACHED", "UNAVAILABLE", "FORBIDDEN", "HOST_NOT_CONFIGURED", "COMMAND_FAILED"]);

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value) + "\n");
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new WorkCommandTransportError("INVALID_INPUT");
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) { request.resume(); throw new WorkCommandTransportError("INVALID_INPUT"); }
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) { request.resume(); throw new WorkCommandTransportError("INVALID_INPUT"); }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Authentication and exact Origin validation run in the existing HTTP surface before this handler. */
export async function serveWorkCommandsRequest(
  request: IncomingMessage, response: ServerResponse, path: string, identity: AccessIdentity, commands?: WorkCommandsPort,
): Promise<void> {
  if (identity.expiresAt <= Date.now() || !identity.context.gatewayAccess?.scopes.includes("terminal-control")) {
    json(response, 403, { error: { code: "FORBIDDEN" } }); return;
  }
  const route = path.slice("/api/work-commands/".length);
  if (!["hosts", "submit", "get", "cancel"].includes(route)) { json(response, 404, { error: { code: "NOT_FOUND" } }); return; }
  if (request.method !== (route === "hosts" ? "GET" : "POST")) { json(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } }); return; }
  if (!commands) {
    json(response, route === "hosts" ? 200 : 503, route === "hosts" ? [] : { error: { code: "UNAVAILABLE" } }); return;
  }
  try {
    const data = route === "hosts" ? await commands.hosts() : route === "submit"
      ? await commands.submit(workCommandSubmitSchema.parse(await body(request)))
      : await commands[route as "get" | "cancel"](workCommandLookupSchema.parse(await body(request)));
    json(response, 200, data);
  } catch (error) {
    const code = error instanceof ZodError || error instanceof SyntaxError ? "INVALID_INPUT"
      : error instanceof WorkCommandTransportError && knownCodes.has(error.code) ? error.code : "UNAVAILABLE";
    const status = code === "FORBIDDEN" ? 403 : code === "UNAVAILABLE" ? 503 : code === "OUTCOME_UNKNOWN" ? 502 : code === "BUSY" || code === "RECOVERY_REQUIRED" || code === "JOURNAL_FULL" || code.includes("CONFLICT") ? 409 : 400;
    json(response, status, { error: { code } });
  }
}
