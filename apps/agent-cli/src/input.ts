import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CliError } from "./output.js";

const flags = ["help", "raw", "wait", "retry", "allow-error", "all-states"] as const;
const values = ["url", "timeout", "state-dir", "request-id", "text", "text-file", "host", "cwd", "model", "mode", "effort", "title", "harness", "limit", "cursor", "cursor-file", "max-events", "turn-id", "response-file", "command-file", "file", "image-id", "source-key", "path", "output"] as const;
const globals = ["url", "timeout", "state-dir", "help"];
const allowed: Record<string, readonly string[]> = {
  help: [], id: [], hosts: ["raw"], sessions: ["raw", "limit", "cursor", "all-states"],
  status: ["raw"], profiles: ["host", "harness"], models: ["host", "harness"],
  history: ["limit", "cursor"], watch: ["cursor-file", "max-events"],
  wait: ["turn-id", "cursor-file"], launch: ["request-id", "host", "cwd", "model", "mode", "effort", "title", "harness"],
  send: ["request-id", "text", "text-file", "image-json", "allow-error", "wait"],
  steer: ["request-id", "text", "text-file", "image-json", "turn-id"],
  interrupt: ["request-id", "turn-id"], resume: ["request-id"], stop: ["request-id"],
  command: ["request-id", "command-file", "allow-error"], operation: ["retry"],
  questions: [], resolve: ["request-id", "response-file"],
  "image-upload": ["file", "image-id"], "image-get": ["image-id", "source-key", "path", "output"],
};
export function parse(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, tokens: true, options: {
      ...Object.fromEntries(flags.map(name => [name, { type: "boolean" as const }])),
      ...Object.fromEntries(values.map(name => [name, { type: "string" as const }])),
      "image-json": { type: "string", multiple: true },
    } });
  } catch { throw new CliError("USAGE", "Invalid option or missing value; run leo-agents help"); }
  const seen = new Set<string>();
  for (const token of parsed.tokens) if (token.kind === "option" && token.name !== "image-json") {
    if (seen.has(token.name)) throw new CliError("USAGE", `--${token.name} must appear only once`);
    seen.add(token.name);
  }
  const options = parsed.values as Record<string, string | boolean | string[] | undefined>;
  const command = options.help ? "help" : parsed.positionals[0] ?? "help";
  if (!Object.hasOwn(allowed, command)) throw new CliError("USAGE", "Unknown command; run leo-agents help");
  if (command !== "help") for (const key of Object.keys(parsed.values)) {
    if (!globals.includes(key) && !allowed[command]!.includes(key)) throw new CliError("USAGE", `--${key} is not supported by ${command}`);
  }
  return { command, positionals: command === "help" ? [] : parsed.positionals.slice(1), options };
}
export type Arguments = ReturnType<typeof parse>;
export function option(args: Arguments, name: string): string | undefined { const value = args.options[name]; return typeof value === "string" ? value : undefined; }
export function required(args: Arguments, name: string): string { const value = option(args, name); if (!value) throw new CliError("USAGE", `--${name} is required`); return value; }
export function integer(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new CliError("USAGE", `Expected an integer from 1 to ${maximum}`);
  return Number(value);
}
export async function inputFile(filename: string, signal: AbortSignal, maximum = 1_048_576): Promise<Buffer> {
  signal.throwIfAborted();
  if (filename === "-") {
    const chunks: Buffer[] = []; let size = 0;
    const abort = () => process.stdin.destroy(new Error("Input cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > maximum) throw new CliError("INPUT_TOO_LARGE", `Input exceeds ${maximum} bytes`);
        chunks.push(bytes); signal.throwIfAborted();
      }
      return Buffer.concat(chunks);
    } finally { signal.removeEventListener("abort", abort); }
  }
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new CliError("INPUT_TOO_LARGE", "Input must be a bounded regular file");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) { signal.throwIfAborted(); const result = await file.read(buffer, size, buffer.length - size); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size > stat.size) throw new CliError("INPUT_CHANGED", "Input changed while reading; retry after the file is stable");
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}
export async function jsonFile(filename: string, signal: AbortSignal): Promise<unknown> {
  try { return JSON.parse((await inputFile(filename, signal)).toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw new CliError("INVALID_JSON", "The input file is not valid JSON"); throw error; }
}
export const commandOptions = allowed;
