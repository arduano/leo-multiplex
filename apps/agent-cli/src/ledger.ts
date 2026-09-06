import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { payloadHash } from "@arduano/agent-multiplex-client";
import { canonicalJson, toJsonValue } from "@arduano/agent-multiplex-protocol";

export interface SavedOperation {
  readonly version: 1;
  readonly origin: string;
  readonly requestId: string;
  readonly intentHash: string;
  readonly createdAt: string;
  readonly kind: "command" | "launch" | "resolve" | "work-command";
  readonly payload: unknown;
}

const MAX_BYTES = 8 * 1_024 * 1_024;
const kinds = new Set(["command", "launch", "resolve", "work-command"]);
const recordKeys = new Set(["version", "origin", "requestId", "intentHash", "createdAt", "kind", "payload"]);

class LedgerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LedgerError"; }
}

/** Immutable, private operation envelopes, committed before the caller sends RPC. */
export class OperationLedger {
  private readonly directory: string;
  constructor(directory: string) {
    if (!directory || directory.includes("\0")) throw invalidInput();
    this.directory = resolve(directory);
  }

  async prepare(
    origin: string,
    requestId: string,
    intent: unknown,
    create: () => Promise<{ kind: SavedOperation["kind"]; payload: unknown }>,
  ): Promise<{ operation: SavedOperation; created: boolean }> {
    validateKey(origin, requestId);
    const intentHash = payloadHash(boundedJson(intent));
    const directory = await openDirectory(this.directory, true);
    if (!directory) throw unsafePath();
    try {
      const filename = join(this.directory, `${payloadHash([origin, requestId])}.json`);
      const existing = await readOperation(filename, origin, requestId);
      if (existing) {
        // Another process may have linked this record immediately before our
        // lookup. Make that directory entry durable before returning it for RPC.
        await directory.sync();
        return matched(existing, intentHash, false);
      }

      // A callback may discover a binding or create a random operation ID. It
      // must not dispatch the mutation: concurrent callbacks can have one winner.
      const candidate = await create();
      if (!candidate || !kinds.has(candidate.kind)) throw invalidInput();
      const operation: SavedOperation = {
        version: 1, origin, requestId, intentHash, createdAt: new Date().toISOString(),
        kind: candidate.kind, payload: boundedJson(candidate.payload),
      };
      const encoded = canonicalJson(toJsonValue(operation));
      if (Buffer.byteLength(encoded) > MAX_BYTES) throw tooLarge();
      await verifyDirectoryIdentity(this.directory, directory);
      const temporary = join(this.directory, `.${randomUUID()}.tmp`);
      let temporaryCreated = false;
      let created = false;
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaryCreated = true;
        try {
          verifyFile(await file.stat());
          await file.writeFile(encoded, "utf8");
          await file.sync();
        } finally { await file.close(); }
        await verifyDirectoryIdentity(this.directory, directory);
        try {
          // link(2) never replaces an existing name. A losing process reads the
          // same complete, fsynced envelope instead of sending its own candidate.
          await link(temporary, filename);
          created = true;
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      } finally {
        if (temporaryCreated) {
          await unlink(temporary);
          // Also sync for a race loser: its return must make the winning link
          // durable even if the winner has not reached its directory sync yet.
          await directory.sync();
        }
      }
      const winner = await readOperation(filename, origin, requestId);
      if (!winner) throw invalidRecord();
      return matched(winner, intentHash, created);
    } finally { await directory.close(); }
  }

  async get(origin: string, requestId: string): Promise<SavedOperation | null> {
    validateKey(origin, requestId);
    const directory = await openDirectory(this.directory, false);
    if (!directory) return null;
    try {
      const operation = await readOperation(join(this.directory, `${payloadHash([origin, requestId])}.json`), origin, requestId);
      if (operation) await directory.sync();
      return operation;
    } finally { await directory.close(); }
  }
}

function matched(operation: SavedOperation, intentHash: string, created: boolean) {
  if (operation.intentHash !== intentHash) {
    throw new LedgerError("REQUEST_CONFLICT", "Request ID already has a different operation intent.");
  }
  return { operation, created };
}

function validateKey(origin: string, requestId: string): void {
  if (typeof origin !== "string" || !origin || origin.includes("\0") || Buffer.byteLength(origin) > 8_192 ||
      typeof requestId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(requestId)) throw invalidInput();
}

/** Apply the published payloadHash JSON semantics, retaining a detached value. */
function boundedJson(value: unknown) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw invalidInput();
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw tooLarge();
    return toJsonValue(JSON.parse(encoded));
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    // Serialization/validation errors can contain user input; do not echo them.
    throw invalidInput();
  }
}

/** Shared ancestors such as sticky /tmp are allowed, but cannot let another
 * user replace the private ledger directory through a writable parent. */
async function openDirectory(path: string, create: boolean): Promise<FileHandle | null> {
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let info: Stats;
    try { info = await lstat(current); }
    catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (!create) return null;
      let created = false;
      try { await mkdir(current, { mode: 0o700 }); created = true; }
      catch (mkdirError) { if (!hasCode(mkdirError, "EEXIST")) throw mkdirError; }
      info = await lstat(current);
      if (created) {
        const parent = await open(dirname(current), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
      }
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw unsafePath();
    if ((!owned(info) && info.uid !== 0) || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) throw unsafePath();
    if (current === path) verifyDirectory(info);
  }
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await verifyDirectoryIdentity(path, directory); return directory; }
  catch (error) { await directory.close(); throw error; }
}

async function verifyDirectoryIdentity(path: string, directory: FileHandle): Promise<void> {
  const actual = await directory.stat();
  const named = await lstat(path);
  verifyDirectory(actual);
  verifyDirectory(named);
  if (named.dev !== actual.dev || named.ino !== actual.ino) throw unsafePath();
}

function owned(info: Stats): boolean {
  return typeof process.getuid === "function" && info.uid === process.getuid();
}

function verifyDirectory(info: Stats): void {
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info) || (info.mode & 0o7777) !== 0o700) throw unsafePath();
}

function verifyFile(info: Stats): void {
  if (!info.isFile() || !owned(info) || (info.mode & 0o7777) !== 0o600) throw unsafePath();
  if (info.size > MAX_BYTES) throw tooLarge();
}

async function readOperation(path: string, origin: string, requestId: string): Promise<SavedOperation | null> {
  let file: FileHandle;
  try {
    // NONBLOCK lets fstat reject a FIFO without ever waiting for a writer.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    if (hasCode(error, "ELOOP")) throw unsafePath();
    throw error;
  }
  try {
    const initial = await file.stat();
    verifyFile(initial);
    // Read at most the declared size plus one byte; concurrent file growth
    // cannot turn a bounded operation lookup into an unbounded allocation.
    const buffer = Buffer.alloc(initial.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const final = await file.stat();
    verifyFile(final);
    if (length !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) throw invalidRecord();
    let operation: unknown;
    try { operation = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { throw invalidRecord(); }
    if (!isSavedOperation(operation, origin, requestId)) throw invalidRecord();
    return operation;
  } finally { await file.close(); }
}

function isSavedOperation(value: unknown, origin: string, requestId: string): value is SavedOperation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const operation = value as Record<string, unknown>;
  const keys = Object.keys(operation);
  if (keys.length !== recordKeys.size || keys.some((key) => !recordKeys.has(key)) ||
      operation.version !== 1 || operation.origin !== origin || operation.requestId !== requestId ||
      typeof operation.intentHash !== "string" || !/^[0-9a-f]{64}$/.test(operation.intentHash) ||
      typeof operation.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(operation.createdAt) ||
      !Number.isFinite(Date.parse(operation.createdAt)) || typeof operation.kind !== "string" || !kinds.has(operation.kind)) return false;
  try { toJsonValue(operation.payload); return true; } catch { return false; }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
function unsafePath() { return new LedgerError("LEDGER_UNSAFE_PATH", "Operation ledger requires an owned private directory and private regular files without symlinks."); }
function invalidInput() { return new LedgerError("LEDGER_INVALID_INPUT", "Operation ledger requires a valid origin, request ID, and JSON input."); }
function invalidRecord() { return new LedgerError("LEDGER_INVALID_RECORD", "Stored operation is malformed or inconsistent; it cannot be retried."); }
function tooLarge() { return new LedgerError("LEDGER_TOO_LARGE", "Operation ledger record exceeds its 8 MiB limit."); }
