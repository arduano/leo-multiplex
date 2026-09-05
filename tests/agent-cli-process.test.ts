import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { initTRPC, TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { nodeHTTPRequestHandler } from "@trpc/server/adapters/node-http";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session = { sessionId: id(1), runtimeNodeId: id(2), runtimeEpoch: id(3), vendorSessionId: "fixture-root", harness: "codex", bindingRevision: 1, availability: "active", catalogState: "open", runtimeStatus: "idle", metadata: { values: {} }, cwd: "/fixture" };
const authority = { realmId: id(4), controlNodeId: id(5), epochId: id(6) };
const heartbeat = { kind: "heartbeat", feedId: id(7), controlCursor: 0, authorityRefs: [authority] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "leo-cli-process-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "assertion"); await writeFile(tokenFile, "fixture-only-token", { mode: 0o600 });
  const events = new Set<(item: unknown) => void>();
  const records = new Map<string, unknown>(); const requests: any[] = []; const origins: unknown[] = [];
  let origin = ""; let behavior = "success"; let subscribed = false;
  const t = initTRPC.context<{ origin?: string; token?: string }>().create();
  const procedure = t.procedure.use(({ ctx, next }) => {
    origins.push(ctx.origin);
    if (ctx.origin !== origin || ctx.token !== "fixture-only-token") throw new TRPCError({ code: "UNAUTHORIZED" });
    return next();
  });
  const emit = (nativeType: string, json: unknown, sequence: number) => {
    for (const event of events) event({ kind: "native", sessionId: session.sessionId, runtimeEpoch: session.runtimeEpoch, harness: "codex", nativeType, sequence, ephemeral: false, provenance: { authority, originControlNodeId: id(5) }, payload: { encoding: "native-json-images-v1", json, images: [] } });
  };
  const router = t.router({
    runtimeNodes: t.router({ list: procedure.query(() => [{ runtimeNodeId: id(2), name: "main-pc", presence: "online", reachability: "reachable", harnesses: [{ harness: "codex" }] }]) }),
    commands: t.router({ get: procedure.input(z.string()).query(({ input }) => records.get(input) ?? null) }),
    sessions: t.router({
      get: procedure.input(z.string()).query(() => session),
      readNativeHistory: procedure.input(z.any()).query(() => ({ payload: { json: { thread: { status: { type: "idle" } } }, images: [] } })),
      execute: procedure.input(z.any()).mutation(async ({ input }) => {
        requests.push(input);
        if (behavior === "drop") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "lost acknowledgment fixture" });
        if (behavior === "success" || behavior === "capacity") {
          expect(subscribed).toBe(true);
          emit("turn/started", { threadId: "fixture-root", turn: { id: "turn-1", status: "inProgress" } }, 0);
          emit("item/completed", { threadId: "fixture-root", turnId: "turn-1", item: { id: "reply-1", type: "agentMessage", text: "fixture reply" } }, 1);
          emit("turn/completed", { threadId: "fixture-root", turn: { id: "turn-1", status: behavior === "capacity" ? "failed" : "completed", error: behavior === "capacity" ? { message: "Model is at capacity", codexErrorInfo: "serverOverloaded" } : null } }, 2);
          // Guarantee completion can race ahead of the HTTP acknowledgement.
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        const record = { ...input, state: "succeeded", result: { json: { turn: { id: "turn-1", status: "inProgress" } }, images: [] } }; records.set(input.commandId, record); return record;
      }),
      watch: procedure.input(z.any()).subscription(() => observable<unknown>(observer => {
        subscribed = true; const push = (item: unknown) => observer.next(item); events.add(push);
        if (behavior === "gap") push({ kind: "nativeGap", sessionId: session.sessionId, reason: "fixture gap", recovery: "readNativeHistory", provenance: { authority, originControlNodeId: id(5) } });
        else push(heartbeat);
        return () => { events.delete(push); subscribed = false; };
      })),
    }),
  });
  const context = ({ req }: { req: import("node:http").IncomingMessage }) => ({ origin: req.headers.origin, token: req.headers["cf-access-jwt-assertion"] as string | undefined });
  const server = createServer((req, res) => { void nodeHTTPRequestHandler({ req, res, router, path: new URL(req.url!, "http://fixture").pathname.replace(/^\/trpc\//, ""), createContext: context }); });
  const wss = new WebSocketServer({ server, path: "/trpc" });
  const wsHandler = applyWSSHandler({ wss, router, createContext: context });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }; origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { wsHandler.broadcastReconnectNotification(); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const run = (args: string[], input = "", auth = true) => new Promise<{ code: number | null; output: any[]; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve("apps/agent-cli/src/main.ts"), ...args, "--url", origin, "--state-dir", join(dir, "ledger"), "--timeout", "4"], {
      env: { ...process.env, LEO_AGENTS_ACCESS_ASSERTION_FILE: auth ? tokenFile : "" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", stderr = ""; const kill = setTimeout(() => child.kill("SIGKILL"), 12_000);
    child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject);
    child.once("exit", code => { clearTimeout(kill); try { resolveRun({ code, output: out.trim() ? out.trim().split("\n").map(line => JSON.parse(line)) : [], stderr }); } catch (error) { reject(error); } });
    child.stdin.end(input);
  });
  return { run, requests, origins, origin, setBehavior(value: string) { behavior = value; }, get subscribed() { return subscribed; } };
}

describe("agent CLI subprocess over HTTP and WebSocket", () => {
  it("sends exact origin/auth headers and correlates completion before acknowledgment", async () => {
    const f = await fixture();
    const r = await f.run(["send", session.sessionId, "--request-id", "sent", "--text-file", "-", "--wait"], "stdin message\nwith newline");
    expect(r.stderr).toBe(""); expect(r.code).toBe(0);
    expect(r.output).toHaveLength(1);
    expect(r.output[0]).toMatchObject({ version: 1, ok: true, data: { acknowledgmentOnly: false, turnId: "turn-1", outcome: { state: "completed", messages: [{ text: "fixture reply" }] } } });
    expect(f.requests[0].request.command.input).toEqual([{ type: "text", text: "stdin message\nwith newline", text_elements: [] }]);
    expect(f.origins.every(origin => origin === f.origin)).toBe(true);
    const repeated = await f.run(["send", session.sessionId, "--request-id", "sent", "--text-file", "-", "--wait"], "stdin message\nwith newline");
    expect(repeated.code).toBe(5); expect(repeated.output[0].error.code).toBe("TURN_OUTCOME_UNKNOWN");
    expect(f.requests).toHaveLength(1);
  });
  it("returns native capacity as attention, not a successful send", async () => {
    const f = await fixture(); f.setBehavior("capacity");
    const r = await f.run(["send", session.sessionId, "--request-id", "capacity", "--text", "fixture", "--wait"]);
    expect(r.code).toBe(7); expect(r.output[0]).toMatchObject({ ok: false, data: { outcome: { state: "failed", failure: { title: "Model at capacity", willRetry: false } } } });
  });
  it("refuses to dispatch after an initial stream gap", async () => {
    const f = await fixture(); f.setBehavior("gap");
    const r = await f.run(["send", session.sessionId, "--request-id", "gap", "--text", "fixture", "--wait"]);
    expect(r.code).toBe(5); expect(f.requests).toHaveLength(0);
  });
  it("keeps exact retries across separate processes after an uncertain response", async () => {
    const f = await fixture(); f.setBehavior("drop");
    const args = ["send", session.sessionId, "--request-id", "uncertain", "--text", "fixture"];
    expect((await f.run(args)).code).toBe(5);
    expect((await f.run(args)).code).toBe(5); expect(f.requests).toHaveLength(1);
    f.setBehavior("ack");
    expect((await f.run(["operation", "uncertain", "--retry"])).code).toBe(0);
    expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]);
    expect((await f.run(["operation", "uncertain", "--retry"])).code).toBe(0); expect(f.requests).toHaveLength(2);
  });
  it("streams bounded NDJSON and exits cleanly", async () => {
    const f = await fixture();
    const r = await f.run(["watch", session.sessionId, "--max-events", "1"]);
    expect(r.code).toBe(0); expect(r.stderr).toBe("");
    expect(r.output).toHaveLength(2); expect(r.output[0].data.item.kind).toBe("heartbeat"); expect(r.output[1].data.count).toBe(1);
  });
  it("returns auth failure and keeps help network-free", async () => {
    const f = await fixture();
    const denied = await f.run(["hosts"], "", false);
    expect(denied.code).toBe(3); expect(denied.output[0].error.code).toBe("UNAUTHORIZED");
    const before = f.origins.length;
    expect((await f.run(["help"], "", false)).code).toBe(0);
    expect(f.origins).toHaveLength(before); expect(f.requests).toHaveLength(0);
  });
  it("times out waiting for an unobserved turn without sending or resuming", async () => {
    const f = await fixture();
    const r = await f.run(["wait", session.sessionId, "--turn-id", "never-observed"]);
    expect(r.code).toBe(6); expect(r.output[0].error.code).toBe("TIMEOUT"); expect(f.requests).toHaveLength(0);
  });
});
