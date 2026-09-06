import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { createServer } from "vite";

// All API and WebSocket traffic is intercepted with disposable data. This
// fixture never contacts an actual host, native session, or model endpoint.
const root = resolve(import.meta.dirname, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function sourceFiles(directory) {
  const files = [];
  for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
    if (item.isDirectory()) files.push(...await sourceFiles(join(directory, item.name)));
    else files.push(join(directory, item.name));
  }
  return files;
}
const sources = [...await sourceFiles("apps/web"), ...await sourceFiles("packages/native-errors"), ...await sourceFiles("packages/session-activity"), "package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "tests/browser/session-status.mjs"];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async (path) => [path, sha256(await readFile(join(root, path)))])));
const output = join(root, "receipts/browser-session-status", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: join(root, "apps/web/vite.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{ name: "fixture-api-guard", configureServer(server) {
    // Closing a browser can race its pending request interceptors. Never let
    // an unhandled request reach Vite's development gateway proxy.
    server.middlewares.use((request, response, next) => {
      if (/^\/(?:trpc|api|auth)(?:\/|\?|$)/.test(request.url ?? "")) { response.statusCode = 503; response.end("Fixture API must be intercepted"); }
      else next();
    });
  } }] });
await vite.listen();
const port = vite.httpServer.address().port;
const browser = await chromium.launch({ ...(process.env.LEO_TEST_CHROMIUM ? { executablePath: process.env.LEO_TEST_CHROMIUM } : {}), headless: true });
const context = await browser.newContext({ viewport: { width: 1720, height: 1180 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const timestamp = "2026-09-06T00:00:00.000Z";
const hosts = ["Main fixture PC", "Fixture home NAS", "Fixture Windows laptop", "Fixture WSL laptop"].map((name, index) => {
  const base = 1000 * (index + 1);
  const authority = { realmId: id(base + 1), controlNodeId: id(base + 2), epochId: id(base + 3) };
  const runtime = { runtimeNodeId: id(base + 4), name, presence: "online", reachability: "reachable", runtimeNodeBootId: id(base + 5), capabilities: [], harnesses: [{ harness: "codex", available: true, capabilities: [] }] };
  const profile = { providerId: "leo.local", profileId: "workspace", contractVersion: 1, requestSchemaHash: String(index + 1).repeat(64), implementationVersion: "1.0.0", harnesses: ["codex"], available: true, capabilities: [] };
  const model = { harness: "codex", id: `model-host-${index + 1}`, name: `Model for host ${index + 1}`, native: { model: `model-host-${index + 1}`, isDefault: true, hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] } };
  const sessions = Array.from({ length: 25 }, (_, sessionIndex) => ({
    sessionId: id(base + 100 + sessionIndex), runtimeNodeId: runtime.runtimeNodeId, metadataAuthority: authority,
    catalogState: "open", catalogRevision: 1, archivedAt: null, harness: "codex", adapterScopeId: `host-${index + 1}`,
    // Native IDs deliberately collide across hosts; UI identity must use the
    // multiplex session/binding, never a vendor ID alone.
    vendorSessionId: `shared-native-${sessionIndex}`, bindingRevision: 1, runtimeEpoch: id(base + 6),
    cwd: `/work/disposable/host-${index + 1}/agent-${sessionIndex + 1}`, availability: "active", runtimeStatus: "idle",
    harnessSettings: { model: model.id, mode: "default", effort: "medium" }, nativeSummary: null, launchProvenance: null,
    metadata: { revision: 1, values: { "agent.title": `Host ${index + 1} agent ${String(sessionIndex + 1).padStart(2, "0")}` }, keyRevisions: { "agent.title": 1 } },
    createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, lastActivityAt: timestamp,
  }));
  return { authority, runtime, profile, model, sessions, index, connected: true,
    source: { sourceId: `fixture-source-${index + 1}`, displayName: name, endpointId: `fixture-endpoint-${index + 1}`, state: "selected", manifest: { coveredControlNodeIds: [authority.controlNodeId] }, updatedAt: timestamp } };
});
const findHost = (runtimeNodeId) => {
  const host = hosts.find((candidate) => candidate.runtime.runtimeNodeId === runtimeNodeId);
  assert(host, `Unknown runtime ${runtimeNodeId}`);
  return host;
};
const findSession = (sessionId) => {
  const session = hosts.flatMap((host) => host.sessions).find((candidate) => candidate.sessionId === sessionId);
  assert(session, `Unknown session ${sessionId}`);
  return session;
};
const subscriptions = new Set();
const searchRequests = [];
const historyRequests = [];
const nativeSubscriptionRequests = [];
const watchedSessionIds = new Set();
const watchChanges = [];
const observations = new Map();
let activityRequests = 0;
let activitySequence = 0;
const approvedHistory = new Set([hosts[0].sessions[0].sessionId]);
const [ready, completed, working, needsInput, failed, interrupted, otherCompleted, stopped, offline, mismatched] = hosts[0].sessions;
function observe(session, kind, label) {
  const { sessionId, runtimeNodeId, adapterScopeId, vendorSessionId, bindingRevision, runtimeEpoch, harness } = session;
  const activity = { sessionId, runtimeNodeId, adapterScopeId, vendorSessionId, bindingRevision, runtimeEpoch, harness, kind, eventId: `fixture-activity-${++activitySequence}`, occurredAt: new Date(Date.parse(timestamp) + activitySequence * 1000).toISOString(), ...(label ? { label } : {}) };
  observations.set(sessionId, activity); return activity;
}
observe(completed, "completion");
working.runtimeStatus = "running"; observe(working, "completion");
needsInput.runtimeStatus = "waitingForInput"; observe(needsInput, "input");
failed.runtimeStatus = "error"; observe(failed, "error", "Model at capacity");
observe(interrupted, "interrupted");
observe(otherCompleted, "completion");
stopped.availability = "stopped"; stopped.runtimeStatus = "stopped"; observe(stopped, "completion");
offline.availability = "unavailable"; observe(offline, "completion");
observe(mismatched, "completion").bindingRevision += 1;
const modelRequests = [];
const launchModelRequests = [];
const commands = [];
const checks = [];
const screenshots = [];
let controlSequence = 0;
await page.routeWebSocket("**/trpc", (socket) => socket.onMessage((message) => {
  if (message === "PING") return socket.send("PONG");
  for (const request of [JSON.parse(message)].flat()) {
    if (request.method === "subscription") {
      if (request.params?.input?.includeNative) {
        nativeSubscriptionRequests.push(request.params.input);
        assert(Array.isArray(request.params.input.sessions) && request.params.input.sessions.length === 1, "Sidebar subscribed to native events for multiple rows");
      }
      subscriptions.add({ socket, id: request.id, input: request.params?.input });
      socket.send(JSON.stringify({ id: request.id, result: { type: "started" } }));
      socket.send(JSON.stringify({ id: request.id, result: { type: "data", data: { kind: "heartbeat", feedId: id(9), controlCursor: controlSequence, authorityRefs: hosts.map((host) => host.authority) } } }));
    } else if (request.method === "subscription.stop") {
      for (const subscription of subscriptions) if (subscription.socket === socket && subscription.id === request.id) subscriptions.delete(subscription);
    }
  }
}));
function emitSessionChanged(session) {
  const data = { kind: "control", eventId: id(100_000 + ++controlSequence), feedId: id(9), cursor: controlSequence,
    provenance: { originControlNodeId: session.metadataAuthority.controlNodeId, authority: session.metadataAuthority }, change: { type: "session.upsert", session } };
  for (const subscription of subscriptions) if (subscription.input?.sessions === "all" || subscription.input?.sessions?.includes?.(session.sessionId)) {
    subscription.socket.send(JSON.stringify({ id: subscription.id, result: { type: "data", data } }));
  }
}
await page.route("**/auth/check", (route) => route.fulfill({ status: 204, body: "" }));
await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ method: "tailscale", storageScope: "a".repeat(43) }) }));
await page.route("**/api/mobile/**", route => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/mobile/activity") {
    activityRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions: [...observations.values()] }) });
  }
  if (pathname.startsWith("/api/mobile/watches/") && route.request().method() === "PUT") {
    const sessionId = decodeURIComponent(pathname.slice("/api/mobile/watches/".length));
    const { watched } = route.request().postDataJSON();
    if (watched) watchedSessionIds.add(sessionId); else watchedSessionIds.delete(sessionId);
    watchChanges.push({ sessionId, watched });
  } else assert.equal(route.request().method(), "GET", "Unexpected fixture notification mutation");
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [], watchedSessionIds: [...watchedSessionIds], delivery: { pending: 0 } }) });
});
await page.route("**/trpc/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const paths = decodeURIComponent(url.pathname.slice("/trpc/".length)).split(",");
  const inputs = JSON.parse(request.method() === "POST" ? request.postData() ?? "{}" : url.searchParams.get("input") ?? "{}");
  const results = [];
  for (const [index, path] of paths.entries()) {
    const input = inputs[index];
    let data;
    switch (path) {
      case "system.describe": data = { componentKind: "access-gateway", protocolVersion: 5 }; break;
      case "sources.list": data = hosts.map((host) => ({ ...host.source, state: host.connected ? "selected" : "unavailable", manifest: host.connected ? host.source.manifest : null })); break;
      case "controlNodes.list": data = hosts.filter((host) => host.connected).map((host) => ({ controlNodeId: host.authority.controlNodeId })); break;
      case "runtimeNodes.list": data = hosts.filter((host) => host.connected).map((host) => host.runtime); break;
      case "sessions.search": {
        searchRequests.push(input);
        const index = input.cursor === undefined ? 0 : Number(input.cursor.replace("fixture-source-page-", ""));
        assert(Number.isInteger(index) && index >= 0 && index < hosts.length, "Invalid fixture page cursor");
        // Every source has a short page, and disconnected sources contribute
        // an empty page with a cursor that must still be followed.
        data = { sessions: hosts[index].connected ? hosts[index].sessions : [], nextCursor: index < hosts.length - 1 ? `fixture-source-page-${index + 1}` : null };
        break;
      }
      case "sessions.get": data = findSession(input); break;
      case "harness.models": modelRequests.push(input); data = [findHost(input.runtimeNodeId).model]; break;
      case "launchProfiles.list": data = [findHost(input.runtimeNodeId).profile]; break;
      case "launchProfiles.models": {
        launchModelRequests.push(input);
        const host = findHost(input.runtimeNodeId);
        assert.equal(input.profile.requestSchemaHash, host.profile.requestSchemaHash, "Launch model discovery crossed host profile fences");
        data = [host.model]; break;
      }
      case "interactions.list": data = []; break;
      case "metadata.get": data = findSession(input.sessionId).metadata; break;
      case "sessions.readNativeHistory": {
        historyRequests.push(input);
        assert(approvedHistory.has(input.sessionId), "Sidebar fetched history for an unselected agent");
        const session = findSession(input.sessionId);
        data = { harness: session.harness, vendorSessionId: session.vendorSessionId, complete: true,
          payload: { encoding: "native-json-images-v1", images: [], json: input.request.includeTurns === false
            ? { thread: { status: { type: "idle" }, turns: [] } }
            : { data: [{ turnId: "shared-history-turn", item: { type: "agentMessage", id: "shared-history-item", phase: "final_answer", text: `History belongs to ${session.metadata.values["agent.title"]}.` } }], nextCursor: null } } };
        break;
      }
      case "sessions.execute": {
        commands.push(input);
        const session = findSession(input.sessionId);
        assert.equal(input.runtimeNodeId, session.runtimeNodeId, "A command was routed to the wrong host");
        const host = findHost(input.runtimeNodeId);
        assert.equal(input.request.command.type, "setModel", "Fixture only authorizes a model change");
        assert.equal(input.request.command.model, host.model.id, "A model selection crossed hosts");
        data = { commandId: input.commandId, payloadHash: input.payloadHash, sessionId: input.sessionId, runtimeNodeId: input.runtimeNodeId, state: "succeeded", request: input.request, result: { encoding: "native-json-images-v1", images: [], json: {} }, createdAt: timestamp, updatedAt: timestamp };
        break;
      }
      case "commands.get": data = null; break;
      default: throw new Error(`Unexpected fixture procedure: ${path}`);
    }
    results.push({ result: { data } });
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(results) });
});
const card = (session) => page.locator(`[data-testid="session-card"][data-session-id="${session.sessionId}"]`);
async function eventually(check, message) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert(Date.now() < deadline, message); await page.waitForTimeout(25); }
}
async function checkHistory(session) {
  const expected = `History belongs to ${session.metadata.values["agent.title"]}.`;
  await page.locator('[data-native-item-id="shared-history-item"]').filter({ hasText: expected }).waitFor();
  assert.equal(await page.locator('[data-native-item-id="shared-history-item"]').count(), 1, "A different session's history leaked into the conversation");
  await eventually(() => page.getByTestId("prompt-input").isEnabled(), "The selected host's prompt never became ready");
}
async function select(session) { approvedHistory.add(session.sessionId); await card(session).click(); await checkHistory(session); }
async function screenshot(name) {
  const file = `${name}.png`;
  await page.screenshot({ path: join(output, file), fullPage: true }); screenshots.push(file);
}
async function axe(name) {
  const result = await new AxeBuilder({ page }).analyze();
  const severe = result.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
  assert.equal(severe.length, 0, `${name}: ${JSON.stringify(severe.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })))}`);
  checks.push({ name, seriousOrCriticalViolations: severe.length });
}
async function status(session, kind, unseen) {
  await eventually(async () => await card(session).getAttribute("data-agent-status") === kind &&
    (unseen === undefined || await card(session).getAttribute("data-unseen") === String(unseen)), `${session.metadata.values["agent.title"]} did not become ${kind}/${unseen}`);
}
async function filter(value, count) {
  const button = page.getByTestId(`agent-filter-${value}`);
  await button.click();
  await eventually(() => page.getByTestId("session-card").count().then(value => value === count), `Filter ${value} did not show ${count} sessions`);
  assert.equal(await button.getAttribute("aria-pressed"), "true");
  assert((await button.innerText()).endsWith(String(count)), `Filter ${value} count did not match its rows`);
}
async function seenEvent(session) {
  return page.evaluate(({ sessionId, scope }) => JSON.parse(localStorage.getItem(`leo.session-seen.${scope}`) ?? "{}")[sessionId], { sessionId: session.sessionId, scope: "a".repeat(43) });
}
async function update(session, runtimeStatus, kind, label) {
  session.runtimeStatus = runtimeStatus;
  const activity = observe(session, kind, label);
  emitSessionChanged(session);
  return activity;
}
try {
  await page.goto(`http://127.0.0.1:${port}`);
  await eventually(() => page.getByTestId("session-card").count().then(count => count === 100), "Initial fleet did not load");
  await checkHistory(ready);
  await status(ready, "ready", false);
  await status(completed, "finished", true);
  await status(working, "working", false);
  await status(needsInput, "input", true);
  await status(failed, "error", true);
  assert((await card(failed).innerText()).includes("Model at capacity"));
  await status(interrupted, "interrupted", true);
  await status(stopped, "stopped", false);
  await status(offline, "offline", false);
  await status(mismatched, "ready", false);
  assert.equal(await page.getByTestId("agent-updates-count").innerText(), "5 new");
  assert.equal(new Set(historyRequests.map(request => request.sessionId)).size, 1, "The 100-row sidebar loaded native histories");
  assert(nativeSubscriptionRequests.every(request => request.sessions[0] === ready.sessionId), "The sidebar watched unselected native streams");
  assert.equal(watchChanges.length, 0, "Viewing initial activity enabled notifications");
  checks.push({ name: "100-row status snapshot distinguishes completion, ready, working, input, error, interrupted, stopped and offline without native fanout", passed: true });

  await filter("needsInput", 3);
  await filter("working", 1);
  await filter("finished", 2);
  await filter("watched", 0);
  await filter("all", 100);
  await page.getByRole("textbox", { name: "Search agents" }).fill(hosts[3].runtime.name);
  await eventually(() => page.getByTestId("session-card").count().then(count => count === 25), "Host search did not find its sessions");
  assert((await page.getByTestId("agent-filter-all").innerText()).endsWith("100"), "Text search changed the fleet filter counts");
  await page.getByRole("textbox", { name: "Search agents" }).fill("");
  await filter("all", 100);
  checks.push({ name: "desktop filters and counts distinguish actionable, working, finished and watched agents; search composes without changing fleet counts", passed: true });

  await select(completed);
  await status(completed, "finished", false);
  const completionEvent = observations.get(completed.sessionId).eventId;
  await eventually(() => seenEvent(completed).then(eventId => eventId === completionEvent), "Visible completion was not acknowledged in browser storage");
  assert.equal(watchChanges.length, 0, "Reviewing a completion opted into notifications");
  subscriptions.clear();
  await page.reload();
  await checkHistory(completed);
  await status(completed, "finished", false);
  await status(otherCompleted, "finished", true);
  assert.equal(await seenEvent(completed), completionEvent);
  await page.getByTestId("desktop-watch-agent-button").click();
  await eventually(() => page.getByTestId("desktop-watch-agent-button").getAttribute("aria-pressed").then(value => value === "true"), "Desktop watch did not acknowledge explicit opt-in");
  assert.deepEqual(watchChanges, [{ sessionId: completed.sessionId, watched: true }]);
  await filter("watched", 1);
  assert.equal(await card(completed).count(), 1);
  await filter("all", 100);
  checks.push({ name: "opening a completion marks only its event seen, persists through reload, and desktop notifications require explicit watch", passed: true });

  // A selected session in a hidden document has not been reviewed.
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await update(completed, "running", "working");
  await status(completed, "working", false);
  const hiddenCompletion = await update(completed, "idle", "completion");
  await status(completed, "finished", true);
  assert.equal(await seenEvent(completed), completionEvent, "A hidden page acknowledged a new completion");
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await status(completed, "finished", false);
  assert.equal(await seenEvent(completed), hiddenCompletion.eventId);
  checks.push({ name: "selected-visible acknowledgment waits until a hidden document becomes visible", passed: true });

  await select(ready);
  await update(completed, "running", "working");
  await status(completed, "working", false);
  await update(completed, "idle", "error", "Model at capacity");
  await status(completed, "error", true);
  assert((await card(completed).innerText()).includes("Model at capacity"));
  await update(completed, "running", "working");
  await status(completed, "working", false);
  await update(completed, "idle", "completion");
  await status(completed, "finished", true);
  await filter("finished", 2);
  await filter("all", 100);
  const beforePoll = activityRequests;
  observe(completed, "error", "Error");
  // Deliberately omit a catalog event. The bounded activity endpoint poll must
  // still recover changes while only the selected agent owns native history.
  await status(completed, "error", true);
  assert(activityRequests > beforePoll);
  await update(completed, "idle", "completion");
  await status(completed, "finished", true);
  checks.push({ name: "subsequent work clears old completion, failures remain actionable, successful completion becomes new again, and missed events recover by bounded polling", passed: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("agents-sheet-button").click();
  const mobileCompletion = await update(ready, "idle", "completion");
  await status(ready, "finished", true);
  assert.notEqual(await seenEvent(ready), mobileCompletion.eventId, "The mobile list acknowledged its hidden selected conversation");
  await select(ready);
  await status(ready, "finished", false);
  assert.equal(await seenEvent(ready), mobileCompletion.eventId);
  const beforeMobileWatch = watchChanges.length;
  await page.getByTestId("watch-agent-button").click();
  await eventually(() => page.getByTestId("watch-agent-button").getAttribute("aria-pressed").then(value => value === "true"), "Mobile watch did not acknowledge opt-in");
  assert.equal(watchChanges.length, beforeMobileWatch + 1);
  assert.deepEqual(watchChanges.at(-1), { sessionId: ready.sessionId, watched: true });
  await page.getByTestId("agents-sheet-button").click();
  await filter("watched", 2);
  assert.equal(await card(ready).count(), 1);
  assert.equal(await card(completed).count(), 1);
  await filter("all", 100);
  await select(ready);
  await page.getByTestId("watch-agent-button").click();
  await eventually(() => page.getByTestId("watch-agent-button").getAttribute("aria-pressed").then(value => value === "false"), "Mobile watch did not disable");
  await page.getByTestId("agents-sheet-button").click();
  await filter("watched", 1);
  await filter("all", 100);
  checks.push({ name: "the mobile agent list never acknowledges its hidden conversation; opening does, and watch remains an explicit reversible opt-in", passed: true });

  for (const [width, height] of [[1720, 1180], [1440, 900], [1024, 768], [768, 1024], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    const mobile = width < 960 || (width < 1280 && height < 500);
    if (mobile && await page.getByTestId("agents-sheet-button").isVisible()) await page.getByTestId("agents-sheet-button").click();
    await page.getByTestId("session-list").waitFor();
    await filter("working", 1);
    await filter("needsInput", 3);
    await filter("finished", 3);
    await filter("watched", 1);
    await filter("all", 100);
    await page.getByRole("textbox", { name: "Search agents" }).fill(hosts[3].runtime.name);
    await eventually(() => page.getByTestId("session-card").count().then(count => count === 25), "Responsive host search failed");
    await page.getByRole("textbox", { name: "Search agents" }).fill("");
    await eventually(() => page.getByTestId("session-card").count().then(count => count === 100), "Clearing responsive search lost rows");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}x${height}`);
    const fleet = await page.getByTestId("fleet-list").boundingBox();
    assert(fleet && fleet.height > 40 && fleet.y >= 0 && fleet.y + fleet.height <= height + 1, `Pinned fleet inaccessible at ${width}x${height}`);
    const bounds = await page.getByTestId("session-list").boundingBox();
    assert(bounds && bounds.height >= 76, `Filters crowded out the session list at ${width}x${height}`);
    await screenshot(`session-status-${width}x${height}`);
    await axe(`session-status-${width}x${height}`);
  }
  assert.equal(commands.length, 0, "Reviewing sidebar activity sent a native command");
  assert.equal(watchChanges.length, 3, "A status/filter/navigation change altered notification opt-in");
  assert(new Set(historyRequests.map(request => request.sessionId)).size <= approvedHistory.size);
  for (const request of nativeSubscriptionRequests) assert(approvedHistory.has(request.sessions[0]) && request.sessions.length === 1);
  assert.deepEqual(errors, []);
  for (const [path, hash] of Object.entries(sourceHashes)) assert.equal(sha256(await readFile(join(root, path))), hash, `Source changed during qualification: ${path}; rerun the suite`);
  const screenshotHashes = Object.fromEntries(await Promise.all(screenshots.map(async (name) => [name, sha256(await readFile(join(output, name)))])));
  await writeFile(join(output, "manifest.json"), JSON.stringify({ status: "passed", fixture: "intercepted activity snapshots, 100 sessions on four hosts", realModelCalls: 0, screenshots, checks, hashes: { ...sourceHashes, ...screenshotHashes } }, null, 2) + "\n");
  console.log(`Session-status browser checks passed (${checks.length}): ${output}`);
} catch (error) {
  await screenshot("failure");
  await writeFile(join(output, "failure.txt"), String(error) + "\n" + errors.join("\n"));
  throw error;
} finally { await context.close(); await browser.close(); await vite.close(); }
