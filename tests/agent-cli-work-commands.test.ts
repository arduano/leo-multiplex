import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessClient } from "@arduano/agent-multiplex-client";
import { dispatch, type Context } from "../apps/agent-cli/src/dispatch.js";
import { OperationLedger } from "../apps/agent-cli/src/ledger.js";
import { parse } from "../apps/agent-cli/src/input.js";
import type { WorkCommandRecord, WorkCommandSubmit } from "../packages/work-commands/src/contract.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "leo-work-cli-")); directories.push(directory);
  const controller = new AbortController();
  const host = { sourceId: "work-wsl", name: "Work WSL", endpointId: "a".repeat(52), platform: "wsl" as const, available: true };
  const records = new Map<string, WorkCommandRecord>();
  const record = (input: WorkCommandSubmit, state: WorkCommandRecord["state"] = "completed"): WorkCommandRecord => ({ ...input.request, payloadHash: "a".repeat(64), state, stdout: "fixture-output\n", stderr: "", truncated: false, exitCode: state === "completed" ? 0 : null, signal: null, createdAt: new Date().toISOString(), finishedAt: state === "running" ? null : new Date().toISOString() });
  const port = {
    hosts: vi.fn(async () => [host]),
    submit: vi.fn(async (input: WorkCommandSubmit) => { const value = record(input); records.set(input.request.operationId, value); return value; }),
    get: vi.fn(async (input: { operationId: string }) => records.get(input.operationId) ?? null),
    cancel: vi.fn(async (input: { operationId: string }) => { const value = records.get(input.operationId); if (!value) return null; value.state = "cancelled"; value.finishedAt = new Date().toISOString(); return value; }),
  };
  const ctx: Context = { client: {} as AccessClient, workCommands: port, origin: "http://127.0.0.1:8444", ledger: new OperationLedger(join(directory, "ledger")), signal: controller.signal, write: vi.fn() };
  const run = (...args: string[]) => dispatch(parse(args), ctx);
  const args = ["exec", "--host", "work-wsl", "--cwd", "/fixture", "--text", "git status --short", "--request-id", "check-1"];
  return { ctx, run, args, port, host, records, record, controller };
}

describe("work laptop CLI", () => {
  it("lists only configured work hosts and saves the exact target before submit", async () => {
    const f = await fixture();
    expect(await f.run("exec-hosts")).toEqual([f.host]);
    f.port.submit.mockImplementationOnce(async input => {
      expect(await f.ctx.ledger.get(f.ctx.origin, "check-1")).toMatchObject({ kind: "work-command", payload: input });
      const value = f.record(input); f.records.set(input.request.operationId, value); return value;
    });
    expect(await f.run(...f.args)).toMatchObject({ requestId: "check-1", target: { sourceId: "work-wsl", endpointId: "a".repeat(52) }, receipt: { exitCode: 0, stdout: "fixture-output\n" } });
    f.port.hosts.mockRejectedValue(new Error("offline"));
    expect(await f.run(...f.args)).toMatchObject({ receipt: { state: "completed" } });
    expect(f.port.submit).toHaveBeenCalledTimes(1);
    await expect(f.run(...f.args.map(value => value === "git status --short" ? "changed" : value))).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });
  it("keeps the same ID after a lost reply and retries only an absent original", async () => {
    const f = await fixture();
    f.port.submit.mockRejectedValueOnce(new Error("secret upstream detail"));
    await expect(f.run(...f.args)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", exitCode: 5, data: { requestId: "check-1" } });
    const original = f.port.submit.mock.calls[0]![0];
    f.host.endpointId = "b".repeat(52);
    await expect(f.run(...f.args)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(f.port.submit).toHaveBeenCalledTimes(1);
    expect(await f.run("exec-status", "check-1", "--retry")).toMatchObject({ receipt: { state: "completed" } });
    expect(f.port.submit.mock.calls[1]![0]).toEqual(original);
    await f.run("operation", "check-1", "--retry");
    expect(f.port.submit).toHaveBeenCalledTimes(2);
    expect(f.port.get.mock.calls.every(([input]) => (input as any).target.endpointId === "a".repeat(52))).toBe(true);
  });
  it("reconciles a committed lost reply and never retries outcomeUnknown", async () => {
    const f = await fixture();
    f.port.submit.mockImplementationOnce(async input => { f.records.set(input.request.operationId, f.record(input, "outcomeUnknown")); throw new Error("lost"); });
    await expect(f.run(...f.args)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(f.run("exec-status", "check-1", "--retry")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(f.port.submit).toHaveBeenCalledTimes(1);
  });
  it("returns output for nonzero exits and stopped commands with useful exit codes", async () => {
    const f = await fixture();
    f.port.submit.mockImplementationOnce(async input => ({ ...f.record(input), exitCode: 42, stderr: "synthetic failure" }));
    await expect(f.run(...f.args)).rejects.toMatchObject({ code: "COMMAND_FAILED", exitCode: 7, data: { receipt: { exitCode: 42, stderr: "synthetic failure" } } });
    f.records.set(f.port.submit.mock.calls[0]![0].request.operationId, f.record(f.port.submit.mock.calls[0]![0], "running"));
    await expect(f.run("exec-cancel", "check-1")).rejects.toMatchObject({ code: "COMMAND_STOPPED", exitCode: 6 });
  });
  it("polls to completion but local interrupt never cancels or loses the saved receipt", async () => {
    const f = await fixture();
    f.port.submit.mockImplementationOnce(async input => { const value = f.record(input, "running"); f.records.set(input.request.operationId, value); setTimeout(() => f.controller.abort(new Error("local timeout")), 30); return value; });
    const running = f.run(...f.args);
    await expect(running).rejects.toMatchObject({ code: "WAIT_INTERRUPTED", exitCode: 6, data: { requestId: "check-1", receipt: { state: "running" } } });
    expect(f.port.cancel).not.toHaveBeenCalled();
    expect(await f.ctx.ledger.get(f.ctx.origin, "check-1")).toMatchObject({ kind: "work-command" });
  });
  it("waits for a terminal receipt and rejects mismatched returned command input", async () => {
    const f = await fixture();
    f.port.submit.mockImplementationOnce(async input => { f.records.set(input.request.operationId, f.record(input)); return f.record(input, "running"); });
    expect(await f.run(...f.args)).toMatchObject({ receipt: { state: "completed", exitCode: 0 } });
    expect(f.port.get).toHaveBeenCalledTimes(1);
    f.port.get.mockResolvedValueOnce({ ...f.record(f.port.submit.mock.calls[0]![0]), command: "different" });
    await expect(f.run("exec-status", "check-1")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });
  it("supports Windows absolute paths and rejects personal or offline targets and oversized UTF-8", async () => {
    const f = await fixture();
    const windows = f.args.map(value => value === "/fixture" ? "C:\\work\\project" : value);
    expect(await f.run(...windows)).toMatchObject({ receipt: { cwd: "C:\\work\\project" } });
    await expect(f.run(...f.args.map(value => value === "work-wsl" ? "main-pc" : value === "check-1" ? "personal" : value))).rejects.toMatchObject({ code: "WORK_HOST_NOT_FOUND" });
    f.host.available = false;
    await expect(f.run(...f.args.map(value => value === "check-1" ? "offline" : value))).rejects.toMatchObject({ code: "WORK_HOST_OFFLINE" });
    await expect(f.run(...f.args.map(value => value === "git status --short" ? "🤖".repeat(5000) : value))).rejects.toMatchObject({ code: "USAGE" });
    expect(f.port.submit).toHaveBeenCalledTimes(1);
  });
});
