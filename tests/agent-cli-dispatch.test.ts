import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newSessionId, newRuntimeNodeId, newRuntimeNodeBootId, newRuntimeEpoch, newControlNodeId, newInteractionId } from "@arduano/agent-multiplex-protocol";
import type { AccessClient } from "@arduano/agent-multiplex-client";
import { dispatch, type Context } from "../apps/agent-cli/src/dispatch.js";
import { OperationLedger } from "../apps/agent-cli/src/ledger.js";
import { parse } from "../apps/agent-cli/src/input.js";
import { gatewayOrigin } from "../apps/agent-cli/src/connection.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "leo-cli-dispatch-")); directories.push(dir);
  const sessionId = newSessionId(), runtimeNodeId = newRuntimeNodeId();
  const session = { sessionId, runtimeNodeId, bindingRevision: 1, runtimeEpoch: newRuntimeEpoch(), vendorSessionId: "native-root", harness: "codex", availability: "active", runtimeStatus: "idle", catalogState: "open", cwd: "/fixture", metadata: { values: { "agent.title": "fixture" } } };
  const host = { runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(), ownerControlNodeId: newControlNodeId(), name: "main-pc", presence: "online", reachability: "reachable", harnesses: [{ harness: "codex" }] };
  const commands = new Map<string, any>(); const launches = new Map<string, any>();
  const client = {
    runtimeNodes: { list: { query: vi.fn(async () => [host]) } },
    launchProfiles: { list: { query: vi.fn(async () => [{ profileId: "workspace", providerId: "leo.local", contractVersion: 1, requestSchemaHash: "a".repeat(64), available: true, harnesses: ["codex"] }]) } },
    launches: { create: { mutate: vi.fn(async p => { const r = { ...p, state: "succeeded" }; launches.set(p.launchId, r); return r; }) }, get: { query: vi.fn(async id => launches.get(id) ?? null) } },
    sessions: {
      get: { query: vi.fn(async () => session) },
      search: { query: vi.fn(async () => ({ sessions: [session], nextCursor: "next-native" })) },
      readNativeHistory: { query: vi.fn(async () => ({ payload: { json: { thread: { status: { type: "idle" } } }, images: [] }, complete: true })) },
      execute: { mutate: vi.fn(async p => { const r = { ...p, state: "succeeded", result: { json: { turn: { id: "turn-1", status: "inProgress" } }, images: [] } }; commands.set(p.commandId, r); return r; }) },
      stop: { mutate: vi.fn() }, resume: { mutate: vi.fn() },
    },
    commands: { get: { query: vi.fn(async id => commands.get(id) ?? null) } },
    interactions: { list: { query: vi.fn(async () => []) }, resolve: { mutate: vi.fn() } },
  };
  const ctx: Context = { client: client as unknown as AccessClient, origin: "http://127.0.0.1:9999", ledger: new OperationLedger(join(dir, "ledger")), signal: new AbortController().signal, write: vi.fn() };
  const run = (...args: string[]) => dispatch(parse(args), ctx);
  return { run, client, session, host, ctx, dir, commands };
}

describe("agent CLI command safety", () => {
  it("returns one bounded catalog/history page with native cursors", async () => {
    const f = await fixture();
    expect(await f.run("sessions", "--limit", "200")).toMatchObject({ nextCursor: "next-native", sessions: [{ sessionId: f.session.sessionId }] });
    await f.run("history", f.session.sessionId, "--limit", "100", "--cursor", "opaque-native");
    expect(f.client.sessions.readNativeHistory.query).toHaveBeenCalledWith({ sessionId: f.session.sessionId, request: { harness: "codex", includeTurns: true, limit: 100, cursor: "opaque-native" } });
    await expect(f.run("history", f.session.sessionId, "--limit", "101")).rejects.toMatchObject({ code: "USAGE" });
    expect(f.client.sessions.execute.mutate).not.toHaveBeenCalled();
  });
  it("persists before dispatch and distinguishes acknowledgment from turn completion", async () => {
    const f = await fixture();
    f.client.sessions.execute.mutate.mockImplementationOnce(async p => {
      expect(await f.ctx.ledger.get(f.ctx.origin, "send-1")).toMatchObject({ payload: p });
      const r = { ...p, state: "succeeded", result: { json: { turn: { id: "turn-1", status: "inProgress" } }, images: [] } }; f.commands.set(p.commandId, r); return r;
    });
    const args = ["send", f.session.sessionId, "--text", "hello", "--request-id", "send-1"];
    expect(await f.run(...args)).toMatchObject({ acknowledgmentOnly: true, turnId: "turn-1", receipt: { state: "succeeded" } });
    f.client.sessions.get.query.mockRejectedValueOnce(new Error("host is offline"));
    expect(await f.run(...args)).toMatchObject({ acknowledgmentOnly: true });
    expect(f.client.sessions.execute.mutate).toHaveBeenCalledTimes(1);
    await expect(f.run("send", f.session.sessionId, "--text", "changed", "--request-id", "send-1")).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(f.client.sessions.execute.mutate).toHaveBeenCalledTimes(1);
  });
  it("never silently retries after a dropped reply; explicit retry is the exact envelope", async () => {
    const f = await fixture();
    f.client.sessions.execute.mutate.mockRejectedValueOnce(new Error("dropped"));
    const args = ["send", f.session.sessionId, "--text", "hello", "--request-id", "lost"];
    await expect(f.run(...args)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", exitCode: 5 });
    const envelope = f.client.sessions.execute.mutate.mock.calls[0]![0];
    f.session.bindingRevision = 99;
    await expect(f.run(...args)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(f.client.sessions.execute.mutate).toHaveBeenCalledTimes(1);
    await f.run("operation", "lost", "--retry");
    expect(f.client.sessions.execute.mutate.mock.calls[1]![0]).toEqual(envelope);
    await f.run("operation", "lost", "--retry");
    expect(f.client.sessions.execute.mutate).toHaveBeenCalledTimes(2);
  });
  it("reconciles a committed send after its HTTP response is lost", async () => {
    const f = await fixture();
    f.client.sessions.execute.mutate.mockImplementationOnce(async p => { f.commands.set(p.commandId, { ...p, state: "succeeded" }); throw new Error("lost response"); });
    await expect(f.run("send", f.session.sessionId, "--text", "hello", "--request-id", "committed")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(await f.run("operation", "committed", "--retry")).toMatchObject({ receipt: { state: "succeeded" } });
    expect(f.client.sessions.execute.mutate).toHaveBeenCalledTimes(1);
  });
  it("blocks native systemError despite idle catalog until deliberately overridden", async () => {
    const f = await fixture();
    f.client.sessions.readNativeHistory.query.mockResolvedValue({ payload: { json: { thread: { status: { type: "systemError" } } }, images: [] }, complete: true });
    const args = ["send", f.session.sessionId, "--text", "continue", "--request-id", "reviewed"];
    await expect(f.run(...args)).rejects.toMatchObject({ code: "NATIVE_ERROR", exitCode: 7 });
    expect(f.client.sessions.execute.mutate).not.toHaveBeenCalled();
    await f.run(...args, "--allow-error");
    expect(f.client.sessions.execute.mutate).toHaveBeenCalledTimes(1);
    expect(f.client.sessions.resume.mutate).not.toHaveBeenCalled();
  });
  it("rejects an active native turn, missing request ID, and inactive session without mutation", async () => {
    const f = await fixture();
    await expect(f.run("send", f.session.sessionId, "--text", "x")).rejects.toMatchObject({ code: "USAGE" });
    f.client.sessions.readNativeHistory.query.mockResolvedValue({ payload: { json: { thread: { status: { type: "active" } } }, images: [] }, complete: true });
    await expect(f.run("send", f.session.sessionId, "--text", "x", "--request-id", "a")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    f.session.availability = "resumable";
    await expect(f.run("send", f.session.sessionId, "--text", "x", "--request-id", "a")).rejects.toMatchObject({ code: "SESSION_INACTIVE" });
    expect(f.client.sessions.execute.mutate).not.toHaveBeenCalled();
  });
  it("uses an exact discovered launch profile and preserves request identity across host changes", async () => {
    const f = await fixture();
    const args = ["launch", "--host", "main-pc", "--cwd", "/fixture", "--request-id", "launch-1", "--model", "fixture-model"];
    const first = await f.run(...args);
    expect(first).toMatchObject({ receipt: { state: "succeeded", input: { cwd: "/fixture", model: "fixture-model" }, profile: { providerId: "leo.local", requestSchemaHash: "a".repeat(64) } } });
    f.host.presence = "offline";
    expect(await f.run(...args)).toEqual(first);
    expect(f.client.launches.create.mutate).toHaveBeenCalledTimes(1);
    await expect(f.run("launch", "--host", "main", "--cwd", "/fixture", "--request-id", "new")).rejects.toMatchObject({ code: "HOST_SELECTION" });
  });
  it("validates native command harness and applies send error protection", async () => {
    const f = await fixture(); const filename = join(f.dir, "command.json");
    await writeFile(filename, JSON.stringify({ harness: "copilot", command: { type: "send", prompt: "x" } }));
    await expect(f.run("command", f.session.sessionId, "--command-file", filename, "--request-id", "native")).rejects.toMatchObject({ code: "HARNESS_MISMATCH" });
    await writeFile(filename, JSON.stringify({ harness: "codex", command: { type: "send", input: "x" } }));
    f.session.runtimeStatus = "error";
    await expect(f.run("command", f.session.sessionId, "--command-file", filename, "--request-id", "native")).rejects.toMatchObject({ code: "NATIVE_ERROR" });
    expect(f.client.sessions.execute.mutate).not.toHaveBeenCalled();
  });
  it("keeps stop/resume explicit and reuses their saved binding fences", async () => {
    const f = await fixture();
    f.client.sessions.stop.mutate.mockImplementation(async p => { const record = { ...p, state: "succeeded" }; f.commands.set(p.commandId, record); return record; });
    f.client.sessions.resume.mutate.mockImplementation(async p => { const record = { ...p, state: "succeeded" }; f.commands.set(p.commandId, record); return record; });
    await f.run("stop", f.session.sessionId, "--request-id", "stop-one");
    f.session.bindingRevision = 2;
    await f.run("stop", f.session.sessionId, "--request-id", "stop-one");
    expect(f.client.sessions.stop.mutate).toHaveBeenCalledTimes(1);
    expect(f.client.sessions.stop.mutate.mock.calls[0][0].bindingRevision).toBe(1);
    await f.run("resume", f.session.sessionId, "--request-id", "resume-one");
    expect(f.client.sessions.resume.mutate.mock.calls[0][0].bindingRevision).toBe(2);
    expect(f.client.sessions.execute.mutate).not.toHaveBeenCalled();
  });
  it("resolves only an explicit native response and checks the exact remote resolution", async () => {
    const f = await fixture(); const interactionId = newInteractionId(); const filename = join(f.dir, "response.json");
    const response = { answers: { q1: { answers: ["Selected answer"] } } }; await writeFile(filename, JSON.stringify(response));
    const record = { interactionId, sessionId: f.session.sessionId, harness: "codex", state: "resolved", resolution: { json: response, images: [] } };
    f.client.interactions.resolve.mutate.mockResolvedValue(record);
    f.client.interactions.list.query.mockResolvedValue([record]);
    const args = ["resolve", f.session.sessionId, interactionId, "--response-file", filename, "--request-id", "answer-one"];
    await f.run(...args); await f.run(...args);
    expect(f.client.interactions.resolve.mutate).toHaveBeenCalledTimes(1);
    expect(f.client.interactions.resolve.mutate).toHaveBeenCalledWith({ interactionId, sessionId: f.session.sessionId, harness: "codex", response });
    f.client.interactions.list.query.mockResolvedValue([{ ...record, resolution: { json: { changed: true }, images: [] } }]);
    await expect(f.run("operation", "answer-one", "--retry")).rejects.toMatchObject({ code: "RESOLUTION_CONFLICT" });
    expect(f.client.interactions.resolve.mutate).toHaveBeenCalledTimes(1);
  });
  it("requires exact session UUIDs and positional arity", async () => {
    const f = await fixture();
    await expect(f.run("send", f.session.sessionId, "surprise", "--request-id", "x", "--text", "x")).rejects.toMatchObject({ code: "USAGE" });
    await expect(f.run("status", "prefix")).rejects.toThrow();
    expect(f.client.sessions.get.query).not.toHaveBeenCalled();
  });
  it("accepts HTTP only on loopback/Tailscale, with no embedded secrets or paths", () => {
    expect(gatewayOrigin("http://100.82.173.47:8444/")).toBe("http://100.82.173.47:8444");
    for (const url of ["http://100.64.example.com", "http://192.168.1.1", "http://100.63.0.1", "http://100.128.0.1", "https://user:secret@example.test", "https://example.test/trpc", "https://example.test?token=x"]) expect(() => gatewayOrigin(url)).toThrow();
  });
});
