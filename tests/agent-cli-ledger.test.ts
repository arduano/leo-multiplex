import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationLedger, type SavedOperation } from "../apps/agent-cli/src/ledger.js";

const directories: string[] = [];
const origin = "https://gateway.example.test";
const requestId = "send-1";
const intent = { sessionId: "session-1", command: { type: "send", input: "Fixture prompt" } };
const command = (id = "command-1") => ({ kind: "command" as const, payload: { commandId: id, request: intent.command } });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "leo-cli-ledger-test-"));
  directories.push(root);
  const directory = join(root, "ledger");
  return { root, directory, ledger: new OperationLedger(directory) };
}

function recordName(targetOrigin = origin, key = requestId): string {
  return `${createHash("sha256").update(JSON.stringify([targetOrigin, key])).digest("hex")}.json`;
}

async function names(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("immutable agent CLI operation ledger", () => {
  it("returns null for a missing operation and persists the exact prepared envelope privately", async () => {
    const { directory, ledger } = await fixture();
    expect(await ledger.get(origin, requestId)).toBeNull();
    const result = await ledger.prepare(origin, requestId, intent, async () => command());
    expect(result.created).toBe(true);
    expect(result.operation).toMatchObject({ version: 1, origin, requestId, ...command() });
    expect(result.operation.intentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isNaN(Date.parse(result.operation.createdAt))).toBe(false);
    expect(await names(directory)).toEqual([recordName()]);
    const file = join(directory, recordName());
    const directoryInfo = await lstat(directory);
    const fileInfo = await lstat(file);
    expect(directoryInfo.isDirectory()).toBe(true);
    expect(directoryInfo.isSymbolicLink()).toBe(false);
    expect(directoryInfo.mode & 0o777).toBe(0o700);
    expect(fileInfo.isFile()).toBe(true);
    expect(fileInfo.isSymbolicLink()).toBe(false);
    expect(fileInfo.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(result.operation);
    expect(await new OperationLedger(directory).get(origin, requestId)).toEqual(result.operation);
  });

  it.each(["command", "launch", "resolve"] as const)("preserves %s payloads across retries without creating a replacement", async (kind) => {
    const { ledger } = await fixture();
    const payload = { operationId: "stable-operation", nested: [null, true, 3.5, { value: "original" }] };
    const first = await ledger.prepare(origin, requestId, intent, async () => ({ kind, payload }));
    const replacement = vi.fn(async () => ({ kind, payload: { operationId: "replacement" } }));
    const replay = await ledger.prepare(origin, requestId, intent, replacement);
    expect(replay).toEqual({ created: false, operation: first.operation });
    expect(replacement).not.toHaveBeenCalled();
  });

  it("canonicalizes nested intent object keys while preserving array order", async () => {
    const { ledger } = await fixture();
    const first = await ledger.prepare(origin, requestId, { b: { second: 2, first: 1 }, a: ["x", "y"] }, async () => command());
    const create = vi.fn(async () => command("replacement"));
    const replay = await ledger.prepare(origin, requestId, { a: ["x", "y"], b: { first: 1, second: 2 } }, create);
    expect(replay.operation).toEqual(first.operation);
    expect(replay.created).toBe(false);
    expect(create).not.toHaveBeenCalled();
    await expect(ledger.prepare(origin, requestId, { a: ["y", "x"], b: { first: 1, second: 2 } }, create))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a different intent before running its creation callback", async () => {
    const { directory, ledger } = await fixture();
    const first = await ledger.prepare(origin, requestId, intent, async () => command());
    const originalBytes = await readFile(join(directory, recordName()));
    const create = vi.fn(async () => command("replacement"));
    await expect(ledger.prepare(origin, requestId, { ...intent, sessionId: "different-session" }, create))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(create).not.toHaveBeenCalled();
    expect(await ledger.get(origin, requestId)).toEqual(first.operation);
    expect(await readFile(join(directory, recordName()))).toEqual(originalBytes);
    expect(await names(directory)).toEqual([recordName()]);
  });

  it("isolates identical request keys by origin", async () => {
    const { directory, ledger } = await fixture();
    const otherOrigin = "https://other-gateway.example.test";
    const first = await ledger.prepare(origin, requestId, intent, async () => command("first-origin"));
    const second = await ledger.prepare(otherOrigin, requestId, { action: "another intent" }, async () => command("second-origin"));
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(await ledger.get(origin, requestId)).toEqual(first.operation);
    expect(await ledger.get(otherOrigin, requestId)).toEqual(second.operation);
    expect(await names(directory)).toEqual([recordName(), recordName(otherOrigin)].sort());
  });

  it("publishes one complete winning envelope across concurrent ledger instances", async () => {
    const { directory } = await fixture();
    const contenders = Array.from({ length: 8 }, (_, index) => new OperationLedger(directory).prepare(origin, requestId, intent, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return command(`candidate-${index}`);
    }));
    const results = await Promise.all(contenders);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const winner = results.find((result) => result.created)!.operation;
    for (const result of results) expect(result.operation).toEqual(winner);
    expect(await new OperationLedger(directory).get(origin, requestId)).toEqual(winner);
    expect(JSON.parse(await readFile(join(directory, recordName()), "utf8"))).toEqual(winner);
    expect(await names(directory)).toEqual([recordName()]);
  });

  it("allows only one intent to win a concurrent request-key race", async () => {
    const { directory } = await fixture();
    const results = await Promise.allSettled(["first", "second"].map((value) =>
      new OperationLedger(directory).prepare(origin, requestId, { input: value }, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return command(value);
      })));
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(fulfilled[0]?.value.created).toBe(true);
    expect(await new OperationLedger(directory).get(origin, requestId)).toEqual(fulfilled[0]?.value.operation);
    expect(await names(directory)).toEqual([recordName()]);
  });

  it.each(["a", "A09._-", "x".repeat(128)])("accepts valid bounded ASCII request key %s", async (key) => {
    const { directory, ledger } = await fixture();
    const result = await ledger.prepare(origin, key, intent, async () => command());
    expect(await ledger.get(origin, key)).toEqual(result.operation);
    expect(await names(directory)).toEqual([recordName(origin, key)]);
  });

  it.each(["", "x".repeat(129), "../escape", "with/slash", "back\\slash", "has space", "line\nbreak", "null\0byte", "é", "🙂"])("rejects invalid request key %j before creating an envelope", async (key) => {
    const { directory, ledger } = await fixture();
    const create = vi.fn(async () => command());
    await expect(ledger.prepare(origin, key, intent, create)).rejects.toThrow();
    await expect(ledger.get(origin, key)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(await names(directory)).toEqual([]);
  });
});

describe("private ledger filesystem boundary", () => {
  it("creates each missing ledger directory with private permissions", async () => {
    const { root } = await fixture();
    const parent = join(root, "new-parent");
    const directory = join(parent, "new-ledger");
    await new OperationLedger(directory).prepare(origin, requestId, intent, async () => command());
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("refuses an existing shared directory without changing its permissions or content", async () => {
    const { directory, ledger } = await fixture();
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    const create = vi.fn(async () => command());
    await expect(ledger.prepare(origin, requestId, intent, create)).rejects.toThrow();
    await expect(ledger.get(origin, requestId)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect(await names(directory)).toEqual([]);
  });

  it("refuses an existing non-private record without chmod or overwrite", async () => {
    const { directory, ledger } = await fixture();
    await ledger.prepare(origin, requestId, intent, async () => command());
    const file = join(directory, recordName());
    const original = await readFile(file);
    await chmod(file, 0o644);
    const create = vi.fn(async () => command("replacement"));
    await expect(ledger.get(origin, requestId)).rejects.toThrow();
    await expect(ledger.prepare(origin, requestId, intent, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(await readFile(file)).toEqual(original);
  });

  it("rejects a symlink at the ledger directory without writing to its target", async () => {
    const { root, directory, ledger } = await fixture();
    const target = join(root, "outside");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, directory);
    const create = vi.fn(async () => command());
    await expect(ledger.prepare(origin, requestId, intent, create)).rejects.toThrow();
    await expect(ledger.get(origin, requestId)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect((await lstat(directory)).isSymbolicLink()).toBe(true);
    expect(await names(target)).toEqual([]);
  });

  it("rejects symlink ancestors even when the ledger leaf does not yet exist", async () => {
    const { root } = await fixture();
    const target = join(root, "real-parent");
    const alias = join(root, "alias-parent");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, alias);
    const create = vi.fn(async () => command());
    const ledger = new OperationLedger(join(alias, "ledger"));
    await expect(ledger.prepare(origin, requestId, intent, create)).rejects.toThrow();
    await expect(ledger.get(origin, requestId)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(await names(target)).toEqual([]);
  });

  it("rejects a writable non-sticky ancestor without creating the ledger or changing permissions", async () => {
    const { root } = await fixture();
    const parent = join(root, "shared-parent");
    await mkdir(parent, { mode: 0o777 });
    await chmod(parent, 0o777);
    const ledger = new OperationLedger(join(parent, "ledger"));
    const create = vi.fn(async () => command());
    await expect(ledger.prepare(origin, requestId, intent, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect((await stat(parent)).mode & 0o777).toBe(0o777);
    expect(await names(parent)).toEqual([]);
  });

  it("rejects symlink records without reading or changing their targets", async () => {
    const { root, directory, ledger } = await fixture();
    await mkdir(directory, { mode: 0o700 });
    const target = join(root, "untouched.json");
    await writeFile(target, "fixture target content", { mode: 0o600 });
    await symlink(target, join(directory, recordName()));
    const create = vi.fn(async () => command());
    await expect(ledger.get(origin, requestId)).rejects.toThrow();
    await expect(ledger.prepare(origin, requestId, intent, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("fixture target content");
    expect((await lstat(join(directory, recordName()))).isSymbolicLink()).toBe(true);
  });

  it("rejects a directory where a regular operation record is required", async () => {
    const { directory, ledger } = await fixture();
    await mkdir(join(directory, recordName()), { recursive: true, mode: 0o700 });
    const create = vi.fn(async () => command());
    await expect(ledger.get(origin, requestId)).rejects.toThrow();
    await expect(ledger.prepare(origin, requestId, intent, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect((await lstat(join(directory, recordName()))).isDirectory()).toBe(true);
  });
});

describe("ledger corruption and failed preparation", () => {
  it.each(["{", "not json", "null", "{}", "[]"])("fails closed on malformed or truncated record %j", async (bytes) => {
    const { directory, ledger } = await fixture();
    await mkdir(directory, { mode: 0o700 });
    const file = join(directory, recordName());
    await writeFile(file, bytes, { mode: 0o600 });
    const create = vi.fn(async () => command());
    await expect(ledger.get(origin, requestId)).rejects.toThrow();
    await expect(ledger.prepare(origin, requestId, intent, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect(await names(directory)).toEqual([recordName()]);
  });

  it.each([
    { version: 2 }, { origin: "https://different.example.test" }, { requestId: "different-key" },
    { intentHash: "not-a-hash" }, { kind: "unknown-kind" },
  ])("rejects invalid durable identity or schema fields %j", async (replacement) => {
    const { directory, ledger } = await fixture();
    const { operation } = await ledger.prepare(origin, requestId, intent, async () => command());
    const bytes = JSON.stringify({ ...operation, ...replacement });
    const file = join(directory, recordName());
    await writeFile(file, bytes);
    await expect(ledger.get(origin, requestId)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("rejects records larger than 8 MiB both before commit and on read", async () => {
    const { directory, ledger } = await fixture();
    await expect(ledger.prepare(origin, requestId, intent, async () => ({ kind: "command", payload: "x".repeat(8 * 1_024 * 1_024) }))).rejects.toThrow();
    expect(await names(directory)).toEqual([]);
    expect(await ledger.get(origin, requestId)).toBeNull();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, recordName());
    await writeFile(file, Buffer.alloc(8 * 1_024 * 1_024 + 1, 32), { mode: 0o600 });
    await expect(ledger.get(origin, requestId)).rejects.toThrow();
    expect((await stat(file)).size).toBe(8 * 1_024 * 1_024 + 1);
  });

  it("leaves no partial record or temporary file when the creation callback throws", async () => {
    const { directory, ledger } = await fixture();
    await expect(ledger.prepare(origin, requestId, intent, async () => { throw new Error("fixture creation failure"); })).rejects.toThrow();
    expect(await names(directory)).toEqual([]);
    expect(await ledger.get(origin, requestId)).toBeNull();
    expect((await ledger.prepare(origin, requestId, intent, async () => command())).created).toBe(true);
    expect(await names(directory)).toEqual([recordName()]);
  });

  it.each(["circular", "bigint"] as const)("leaves no partial record or temporary file for an unserializable %s payload", async (invalid) => {
    const { directory, ledger } = await fixture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const payload = invalid === "circular" ? circular : { value: 1n };
    await expect(ledger.prepare(origin, requestId, intent, async () => ({ kind: "command", payload }))).rejects.toThrow();
    expect(await names(directory)).toEqual([]);
    expect(await ledger.get(origin, requestId)).toBeNull();
    const { operation }: { operation: SavedOperation } = await ledger.prepare(origin, requestId, intent, async () => command());
    expect(await ledger.get(origin, requestId)).toEqual(operation);
  });
});
