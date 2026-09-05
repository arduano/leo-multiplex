export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 2, readonly data?: unknown) { super(message); }
}
export function result(command: string, data: unknown) { return { version: 1, ok: true, command, data }; }
export function errorResult(error: unknown) {
  const e = error as { code?: unknown; message?: unknown; data?: { code?: unknown }; exitCode?: number };
  const code = error instanceof CliError ? error.code : String(e?.data?.code ?? e?.code ?? "REQUEST_FAILED");
  const message = String(e?.message ?? "Request failed").slice(0, 16_384)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  return { version: 1, ok: false, error: { code, message }, ...(error instanceof CliError && error.data !== undefined ? { data: error.data } : {}) };
}
export async function writeJson(value: unknown): Promise<void> {
  const line = JSON.stringify(value) + "\n";
  await new Promise<void>((resolve, reject) => process.stdout.write(line, error => error ? reject(error) : resolve()));
}
