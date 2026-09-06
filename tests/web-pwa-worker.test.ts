import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function worker() {
  const handlers = new Map<string, (event: any) => void>();
  const notifications: unknown[] = [];
  const source = readFileSync("apps/web/src/service-worker.js", "utf8").replace("__LEO_BUILD_CONFIG__", JSON.stringify({ version: "fixture", assets: ["/assets/app-fixture.js", "/offline-shell.html"] }));
  const cache = new Map<string, Response>();
  const calls: string[] = [];
  let fail = false;
  const scope = { location: { origin: "https://fixture.example.test" }, addEventListener: (name: string, listener: any) => handlers.set(name, listener),
    registration: { showNotification: async (...args: unknown[]) => { notifications.push(args); } },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async (url: string) => { calls.push(url); } }, skipWaiting: async () => { calls.push("activate"); },
  };
  runInNewContext(source, { self: scope, URL, Response, Request, AbortSignal, Set, Uint8Array, crypto: globalThis.crypto, btoa,
    caches: { open: async () => ({ match: async (path: string) => cache.get(path)?.clone(), put: async (path: string, response: Response) => { cache.set(path, response); } }), keys: async () => ["leo-shell-fixture"], delete: async () => { cache.clear(); } },
    fetch: async (input: Request | string) => {
      if (fail) throw Error("Offline");
      const path = typeof input === "string" ? input : new URL(input.url).pathname;
      calls.push(path);
      return new Response(path.endsWith(".html") ? '<html><head><meta name="leo-offline" content="true"></head><body>fixture</body></html>' : "fixture", { headers: { "Content-Type": path.endsWith(".js") ? "text/javascript" : "text/html" } });
    },
  });
  function dispatch(name: string, extra = {}) {
    let response: Promise<Response> | undefined; let work: Promise<unknown> | undefined;
    handlers.get(name)!({ ...extra, respondWith: (value: Promise<Response>) => { response = value; }, waitUntil: (value: Promise<unknown>) => { work = value; } });
    return { response, work };
  }
  return { dispatch, cache, calls, notifications, offline: () => { fail = true; } };
}
describe("PWA worker data boundary", () => {
  it("never intercepts authentication, RPC, image reads or writes", () => {
    const w = worker();
    for (const path of ["/auth/session", "/trpc/sessions.readNativeHistory", "/api/mobile/state", "/cdn-cgi/access/login", "/images/asset"]) {
      expect(w.dispatch("fetch", { request: new Request("https://fixture.example.test" + path) }).response).toBeUndefined();
    }
    expect(w.dispatch("fetch", { request: new Request("https://fixture.example.test/", { method: "POST", body: "private input" }) }).response).toBeUndefined();
  });
  it("caches only the build allowlist and constructs a fresh CSP nonce for offline entry", async () => {
    const w = worker(); await w.dispatch("install").work;
    expect([...w.cache.keys()]).toEqual(["/assets/app-fixture.js", "/offline-shell.html"]);
    expect(w.calls).not.toContain("activate");
    w.offline();
    const response = await w.dispatch("fetch", { request: { url: "https://fixture.example.test/", method: "GET", mode: "navigate" } }).response;
    const html = await response!.text();
    const nonce = /name="agent-multiplex-style-nonce" content="([^"]+)"/.exec(html)![1];
    expect(response!.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(await w.cache.get("/offline-shell.html")!.clone().text()).not.toContain("agent-multiplex-style-nonce");
    expect(response!.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects invalid/stale pushes and click paths cannot become external links", async () => {
    const w = worker();
    for (const payload of [{ title: "hello", body: "hello", eventId: "x", sessionId: "https://evil.test" }, { title: "hello", body: "hello", eventId: "x", expiresAt: "2020-01-01T00:00:00Z" }]) await w.dispatch("push", { data: { json: () => payload } }).work;
    expect(w.notifications).toHaveLength(0);
    await w.dispatch("push", { data: { json: () => ({ version: 1, kind: "completion", tag: "fixture", expiresAt: "2099-01-01T00:00:00Z", title: "Agent finished", body: "Ready", eventId: "turn-fixture", sessionId: "00000000-0000-4000-8000-000000000001" }) } }).work;
    expect(w.notifications).toHaveLength(1);
    await w.dispatch("notificationclick", { notification: { close() {}, data: { sessionId: "https://evil.test" } } }).work;
    expect(w.calls).toEqual(["/#/agents"]);
  });
});
