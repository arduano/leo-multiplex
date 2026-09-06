import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import WebSocket from "ws";
import { isIPv4 } from "node:net";
import { createWebSocketTRPCClient } from "@arduano/agent-multiplex-client";
import type { AccessRouter } from "@arduano/agent-multiplex-control-node-core";
import { createWorkCommandsHttpClient } from "../../../packages/work-commands/src/http-client.js";
import { CliError } from "./output.js";

export const DEFAULT_URL = "http://100.82.173.47:8444";
export function gatewayOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError("INVALID_URL", "Use the gateway origin, such as https://agents.example.test"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["http:", "https:"].includes(url.protocol)) {
    throw new CliError("INVALID_URL", "The gateway URL must be an HTTP(S) origin without credentials, a path, or query parameters");
  }
  const octets = url.hostname.split(".").map(Number);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const tailnet = isIPv4(url.hostname) && octets.length === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  if (url.protocol === "http:" && !local && !tailnet) throw new CliError("INSECURE_URL", "HTTP is supported only for loopback or Tailscale IPv4 addresses");
  return url.origin;
}

/** A Cloudflare assertion is optional; Tailscale obtains identity from Serve. */
function assertion(filename: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error();
    const token = readFileSync(fd, "utf8").trim();
    if (!token || /\s/.test(token)) throw new Error();
    return token;
  } catch { throw new CliError("AUTH_FILE", "The Access assertion file must be a private, owner-only regular file containing one token", 3); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function connect(origin: string, signal: AbortSignal, assertionFile?: string) {
  const headers = () => ({ Origin: origin, ...(assertionFile ? { "Cf-Access-Jwt-Assertion": assertion(assertionFile) } : {}) });
  class AuthenticatedSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) { super(address, protocols, { headers: headers(), followRedirects: false }); }
  }
  const standard = createWebSocketTRPCClient<AccessRouter>({
    url: `${origin}/trpc`, headers,
    fetch: async (url, options) => {
      const response = await fetch(url, { ...options, redirect: "error", signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new CliError("UNAUTHORIZED", "The gateway rejected this identity. Check Tailscale owner sign-in or the private Access assertion file.", 3);
      }
      return response;
    },
    subscription: {
      url: origin.replace(/^http/, "ws") + "/trpc",
      WebSocket: AuthenticatedSocket as unknown as typeof globalThis.WebSocket,
      lazy: { enabled: true, closeMs: 0 },
      keepAlive: { enabled: true, intervalMs: 10_000, pongTimeoutMs: 3_000 },
    },
  });
  return { ...standard, workCommands: createWorkCommandsHttpClient({ origin, signal, headers }) };
}
