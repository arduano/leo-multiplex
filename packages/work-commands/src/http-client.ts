import { z } from "zod";
import { MAX_OUTPUT_BYTES, workCommandLookupSchema, workCommandRecordSchema, workCommandSubmitSchema, workHostPairingSchema, type WorkCommandRecord, type WorkCommandRequest, type WorkCommandsPort } from "./contract.js";

const hostsSchema = z.array(workHostPairingSchema.omit({ locator: true }).extend({ available: z.boolean() }).strict()).max(100);
const MAX_RESPONSE_BYTES = 1_048_576;
const messages: Record<string, string> = {
  UNAUTHORIZED: "Sign in to the gateway again.", FORBIDDEN: "This identity cannot use work commands.",
  BUSY: "A command is already running on this host. Check it before starting another.",
  HOST_NOT_CONFIGURED: "The saved work host is no longer configured. Its target cannot be changed.",
  UNAVAILABLE: "The work host is unavailable. Check the original command when it reconnects.",
  OUTCOME_UNKNOWN: "The command may have started. Check its saved operation before retrying.",
  RECOVERY_REQUIRED: "The host requires local recovery after an uncertain command. Review the host before running more commands.",
  JOURNAL_FULL: "The host command journal is full. Perform local recovery before running more commands.",
  INVALID_CWD: "The working directory is invalid on this host.", CWD_NOT_ALLOWED: "Choose a working directory inside this host's configured roots.",
  INVALID_INPUT: "The command input is invalid.", REQUEST_CONFLICT: "This operation ID already has different input.",
  INVALID_RESPONSE: "The gateway returned an invalid command receipt. Check the original operation.",
};
export class WorkCommandHttpError extends Error {
  constructor(readonly code: string) { super(messages[code] ?? "The work command request failed. Check the original operation."); }
}

/** Personal HTTP surface, deliberately independent of the framework AccessRouter. */
export function createWorkCommandsHttpClient(options: {
  origin: string; signal?: AbortSignal; headers?: () => HeadersInit; fetch?: typeof fetch;
}): WorkCommandsPort {
  const origin = new URL(options.origin).origin;
  async function request(route: string, input?: unknown): Promise<unknown> {
    const headers = new Headers(options.headers?.());
    if (input !== undefined) headers.set("content-type", "application/json");
    const response = await (options.fetch ?? globalThis.fetch)(`${origin}/api/work-commands/${route}`, {
      method: input === undefined ? "GET" : "POST", headers, credentials: "same-origin", redirect: "error", cache: "no-store",
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel(); throw new WorkCommandHttpError(response.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN");
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) { await response.body?.cancel(); throw new WorkCommandHttpError("INVALID_RESPONSE"); }
    const reader = response.body?.getReader();
    if (!reader) throw new WorkCommandHttpError("INVALID_RESPONSE");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new WorkCommandHttpError("INVALID_RESPONSE"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const buffer = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
    catch { throw new WorkCommandHttpError("INVALID_RESPONSE"); }
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(value);
      const code = parsed.success && /^[A-Z_]{1,64}$/.test(parsed.data.error.code) ? parsed.data.error.code : "UNAVAILABLE";
      throw new WorkCommandHttpError(code);
    }
    return value;
  }
  function record(value: unknown): WorkCommandRecord | null {
    const parsed = workCommandRecordSchema.nullable().safeParse(value);
    if (!parsed.success || parsed.data && new TextEncoder().encode(parsed.data.stdout + parsed.data.stderr).byteLength > MAX_OUTPUT_BYTES) throw new WorkCommandHttpError("INVALID_RESPONSE");
    return parsed.data;
  }
  return {
    async hosts() { const value = hostsSchema.safeParse(await request("hosts")); if (!value.success) throw new WorkCommandHttpError("INVALID_RESPONSE"); return value.data; },
    async submit(input) { const value = record(await request("submit", workCommandSubmitSchema.parse(input))); if (!value) throw new WorkCommandHttpError("INVALID_RESPONSE"); return matchingWorkCommand(input.request, value); },
    async get(input) { const value = record(await request("get", workCommandLookupSchema.parse(input))); if (value && value.operationId !== input.operationId) throw new WorkCommandHttpError("INVALID_RESPONSE"); return value; },
    async cancel(input) { const value = record(await request("cancel", workCommandLookupSchema.parse(input))); if (value && value.operationId !== input.operationId) throw new WorkCommandHttpError("INVALID_RESPONSE"); return value; },
  };
}

export function matchingWorkCommand(request: WorkCommandRequest, record: WorkCommandRecord): WorkCommandRecord {
  if (record.operationId !== request.operationId || record.command !== request.command || record.cwd !== request.cwd || record.timeoutMs !== request.timeoutMs) throw new WorkCommandHttpError("INVALID_RESPONSE");
  return record;
}
