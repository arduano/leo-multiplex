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
const sources = [...await sourceFiles("apps/web"), ...await sourceFiles("packages/native-errors"), "package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "tests/browser/multi-host.mjs"];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async (path) => [path, sha256(await readFile(join(root, path)))])));
const output = join(root, "receipts/browser-multi-host", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: join(root, "apps/web/vite.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: false } });
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
const modelRequests = [];
const launchModelRequests = [];
const commands = [];
const checks = [];
const screenshots = [];
let controlSequence = 0;
const nativeSequences = new Map();
await page.routeWebSocket("**/trpc", (socket) => socket.onMessage((message) => {
  if (message === "PING") return socket.send("PONG");
  for (const request of [JSON.parse(message)].flat()) {
    if (request.method === "subscription") {
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
function emitNative(session, text, { includeStaleSubscriber = false } = {}) {
  const sequence = (nativeSequences.get(session.sessionId) ?? 0) + 1;
  nativeSequences.set(session.sessionId, sequence);
  const data = { kind: "native", sessionId: session.sessionId, harness: "codex", runtimeEpoch: session.runtimeEpoch, sequence,
    nativeType: "item/completed", ephemeral: false, provenance: { originControlNodeId: session.metadataAuthority.controlNodeId, authority: session.metadataAuthority },
    payload: { encoding: "native-json-images-v1", images: [], json: { threadId: session.vendorSessionId, turnId: "shared-live-turn", item: { type: "agentMessage", id: "shared-live-item", phase: "final_answer", text } } } };
  for (const subscription of subscriptions) if (subscription.input?.includeNative && (includeStaleSubscriber || subscription.input.sessions?.includes?.(session.sessionId))) {
    subscription.socket.send(JSON.stringify({ id: subscription.id, result: { type: "data", data } }));
  }
}
await page.route("**/auth/check", (route) => route.fulfill({ status: 204, body: "" }));
await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ method: "tailscale", storageScope: "a".repeat(43) }) }));
await page.route("**/api/mobile/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices: [], watchedSessionIds: [], delivery: { pending: 0 } }) }));
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
async function select(session) { await card(session).click(); await checkHistory(session); }
async function refresh() { await page.evaluate(() => window.dispatchEvent(new Event("online"))); }
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
try {
  await page.goto(`http://127.0.0.1:${port}`);
  await eventually(() => page.getByTestId("session-card").count().then((count) => count === 100), "All four short source pages were not loaded");
  await checkHistory(hosts[0].sessions[0]);
  assert.equal(await page.getByTestId("runtime-node-card").count(), 4);
  for (let index = 1; index < 4; index++) assert(searchRequests.some((request) => request.cursor === `fixture-source-page-${index}`));
  for (const host of hosts) for (const session of host.sessions) assert.equal(await card(session).count(), 1);
  checks.push({ name: "100 unique sessions from four independent short source pages remain available", passed: true });

  // Same native IDs across all hosts are intentional. Drafts, native history,
  // model catalogs and commands must continue to use the multiplex identity.
  for (const host of hosts) {
    const session = host.sessions[24];
    await select(session);
    await page.getByTestId("prompt-input").fill(`Draft only for host ${host.index + 1}`);
    await page.getByTestId("agent-settings-button").click();
    await page.getByTestId(`model-option-${host.model.id}`).waitFor();
    for (const other of hosts.filter((other) => other !== host)) assert.equal(await page.getByTestId(`model-option-${other.model.id}`).count(), 0);
    await page.keyboard.press("Escape");
  }
  for (const host of hosts) {
    await select(host.sessions[24]);
    await eventually(() => page.getByTestId("prompt-input").inputValue().then((text) => text === `Draft only for host ${host.index + 1}`), "Host switching mixed or discarded drafts");
  }
  assert.equal(new Set(modelRequests.map((request) => request.runtimeNodeId)).size, 4);
  checks.push({ name: "selection, drafts, history and model catalogs stay isolated despite colliding native IDs", passed: true });

  const selected = hosts[3].sessions[24];
  await eventually(() => [...subscriptions].some((subscription) => subscription.input?.includeNative && subscription.input.sessions?.includes?.(selected.sessionId)), "Selected session never subscribed");
  emitNative(selected, "Live text belongs only to host four.");
  await page.locator('[data-native-item-id="shared-live-item"]').filter({ hasText: "Live text belongs only to host four." }).waitFor();
  emitNative(hosts[1].sessions[24], "A delayed event from another host must stay hidden.", { includeStaleSubscriber: true });
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("A delayed event from another host must stay hidden.", { exact: true }).count(), 0);
  assert((await page.locator('[data-native-item-id="shared-live-item"]').innerText()).includes("Live text belongs only to host four."));
  hosts[1].sessions[24].metadata.values["agent.title"] = "NAS title updated externally";
  hosts[1].sessions[24].metadata.revision += 1;
  emitSessionChanged(hosts[1].sessions[24]);
  await card(hosts[1].sessions[24]).filter({ hasText: "NAS title updated externally" }).waitFor();
  assert.equal(await card(selected).getAttribute("aria-current"), "true");
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "Draft only for host 4");
  assert.equal(await page.getByTestId("session-card").count(), 100);
  checks.push({ name: "live events and external catalog updates preserve the selected host and reject another session's native stream", passed: true });

  await page.getByTestId("spawn-button").click();
  await page.getByTestId("spawn-form").waitFor();
  assert.equal(await page.getByTestId("spawn-runtime-select").locator("option").count(), 4);
  for (const host of hosts) {
    await page.getByTestId("spawn-runtime-select").selectOption(host.runtime.runtimeNodeId);
    await eventually(() => page.getByTestId("spawn-model-select").locator("option").allTextContents().then((options) => options.includes(host.model.name)), "Launch model discovery did not follow the chosen host");
    assert.deepEqual(await page.getByTestId("spawn-model-select").locator("option").allTextContents(), ["Host default", host.model.name]);
    await page.getByTestId("spawn-model-select").selectOption(host.model.id);
  }
  assert.equal(new Set(launchModelRequests.map((request) => request.runtimeNodeId)).size, 4);
  await page.getByTestId("spawn-runtime-select").selectOption(hosts[1].runtime.runtimeNodeId);
  await page.getByTestId("spawn-cwd-input").fill("/work/disposable/nas-only-workspace");
  hosts[1].connected = false;
  await refresh();
  await eventually(() => page.getByTestId("runtime-node-card").count().then((count) => count === 3), "Disconnected host stayed in runtime discovery");
  assert.equal(await page.getByTestId("spawn-runtime-select").inputValue(), hosts[1].runtime.runtimeNodeId, "A disappearing launch host silently retargeted the form to a different computer");
  assert.equal(await page.getByTestId("spawn-cwd-input").inputValue(), "/work/disposable/nas-only-workspace", "A disappearing launch host discarded the workdir");
  assert.equal(await page.getByTestId("spawn-submit").isDisabled(), true, "Launch stayed enabled when its chosen host disappeared");
  hosts[1].connected = true;
  await refresh();
  await eventually(() => page.getByTestId("runtime-node-card").count().then((count) => count === 4), "Reconnecting host stayed absent from runtime discovery");
  await eventually(() => page.getByTestId("spawn-submit").isEnabled(), "The chosen host's reconnect did not restore launch readiness");
  assert.equal(await page.getByTestId("spawn-runtime-select").inputValue(), hosts[1].runtime.runtimeNodeId);
  assert.equal(await page.getByTestId("spawn-cwd-input").inputValue(), "/work/disposable/nas-only-workspace");
  await page.keyboard.press("Escape");
  checks.push({ name: "new-agent host choices discover only that runtime's models with its exact launch profile fence", passed: true });
  checks.push({ name: "a disappearing chosen launch host disables submission without silently retargeting or losing the directory, then recovers on reconnect", passed: true });

  // The NAS source becomes unavailable while a different source remains
  // selected. Its empty page must not prevent later sources from loading.
  hosts[1].connected = false;
  await refresh();
  await eventually(() => card(hosts[1].sessions[24]).getAttribute("data-stale").then((value) => value === "true"), "Disconnected source rows were not marked stale");
  await eventually(() => page.getByTestId("runtime-node-card").count().then((count) => count === 3), "Disconnected runtime stayed available");
  assert.equal(await page.getByTestId("session-card").count(), 100, "Disconnect removed a host's cached sessions");
  for (const host of hosts.filter((host) => host.connected)) for (const session of host.sessions) assert.equal(await card(session).getAttribute("data-stale"), "false");
  assert.equal(await card(selected).getAttribute("aria-current"), "true");
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "Draft only for host 4");
  assert.equal(await page.getByTestId("prompt-input").isEnabled(), true);
  await card(hosts[1].sessions[24]).click();
  await page.getByTestId("stale-session-notice").waitFor();
  assert.equal(await page.getByTestId("send-button").isDisabled(), true);
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "Draft only for host 2");
  await page.getByTestId("spawn-button").click();
  await page.getByTestId("spawn-form").waitFor();
  const unavailableHostOption = page.getByTestId("spawn-runtime-select").locator(`option[value="${hosts[1].runtime.runtimeNodeId}"]`);
  assert(await unavailableHostOption.count() === 0 || await unavailableHostOption.getAttribute("disabled") !== null, `A disconnected host remains launchable: ${await unavailableHostOption.evaluateAll((elements) => elements.map((element) => element.outerHTML))}`);
  await page.keyboard.press("Escape");
  await screenshot("four-host-one-disconnected");
  hosts[1].connected = true;
  await refresh();
  await eventually(() => card(hosts[1].sessions[24]).getAttribute("data-stale").then((value) => value === "false"), "Reconnecting source stayed stale");
  await checkHistory(hosts[1].sessions[24]);
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "Draft only for host 2");
  assert.equal(await page.getByTestId("session-card").count(), 100);
  checks.push({ name: "one disconnected source retains read-only drafts, cannot launch, and reconnects without disturbing the other three sources", passed: true });

  for (let cycle = 0; cycle < 3; cycle++) {
    await select(hosts[3].sessions[24]);
    hosts[2].connected = false;
    hosts[3].connected = false;
    await refresh();
    await page.getByTestId("stale-session-notice").waitFor();
    assert.equal(await page.getByTestId("send-button").isDisabled(), true);
    assert.equal(await page.getByTestId("prompt-input").inputValue(), "Draft only for host 4");
    assert.equal(await page.getByTestId("session-card").count(), 100);
    for (const host of hosts.slice(2)) for (const session of host.sessions) assert.equal(await card(session).getAttribute("data-stale"), "true");
    for (const host of hosts.slice(0, 2)) {
      await select(host.sessions[24]);
      assert.equal(await card(host.sessions[24]).getAttribute("data-stale"), "false");
      assert.equal(await page.getByTestId("send-button").isEnabled(), true);
    }
    // Windows and WSL can wake independently; restore WSL first.
    hosts[3].connected = true;
    await refresh();
    await eventually(() => card(hosts[3].sessions[24]).getAttribute("data-stale").then(value => value === "false"), "WSL stayed stale after wake");
    assert.equal(await card(hosts[2].sessions[24]).getAttribute("data-stale"), "true");
    await select(hosts[3].sessions[24]);
    assert.equal(await page.getByTestId("prompt-input").inputValue(), "Draft only for host 4");
    hosts[2].connected = true;
    await refresh();
    await eventually(() => card(hosts[2].sessions[24]).getAttribute("data-stale").then(value => value === "false"), "Windows stayed stale after wake");
    assert.equal(await page.getByTestId("session-card").count(), 100);
  }
  checks.push({ name: "three simultaneous Windows and WSL sleep cycles preserve 100 rows and drafts, keep other hosts usable, and recover in either source order without dispatch", passed: true });

  for (const [width, height] of [[1720, 1180], [1440, 900], [1024, 768], [768, 1024], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    const mobile = width < 960 || (width < 1280 && height < 500);
    if (mobile) {
      await page.getByTestId("agents-sheet-button").click();
      await page.getByTestId("mobile-agents-home").waitFor();
      for (const host of hosts) {
        await select(host.sessions[24]);
        assert.equal(await page.getByTestId("prompt-input").inputValue(), `Draft only for host ${host.index + 1}`);
        await page.getByTestId("agents-sheet-button").click();
      }
    }
    await page.getByTestId("session-list").waitFor();
    await page.getByRole("textbox", { name: "Search agents" }).fill(hosts[3].runtime.name);
    await eventually(() => page.getByTestId("session-card").count().then((count) => count === 25), "Searching by the displayed host name did not find its 25 sessions");
    for (const session of hosts[3].sessions) assert.equal(await card(session).count(), 1);
    await page.getByRole("textbox", { name: "Search agents" }).fill("Host 4 agent 25");
    await eventually(() => page.getByTestId("session-card").count().then((count) => count === 1), "Search failed to narrow the fleet to its fourth-host session");
    assert.equal(await card(hosts[3].sessions[24]).count(), 1);
    await page.getByRole("textbox", { name: "Search agents" }).fill("");
    await eventually(() => page.getByTestId("session-card").count().then((count) => count === 100), "Clearing search did not restore all four hosts");
    assert.equal(await page.getByTestId("runtime-node-card").count(), 4);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}x${height}`);
    const fleet = await page.getByTestId("fleet-list").boundingBox();
    assert(fleet && fleet.height > 40 && fleet.y >= 0 && fleet.y + fleet.height <= height, "The 100-session list pushed hosts out of reach");
    await screenshot(`four-host-fleet-${width}x${height}`);
    await axe(`four-host-fleet-${width}x${height}`);
    if (mobile) await select(hosts[0].sessions[24]);
  }
  checks.push({ name: "100-session search and four-host navigation preserve drafts and reachable fleet across six desktop/tablet/mobile viewports", passed: true });
  assert.equal(commands.length, 0, "Reading, selecting, discovering models or reconnecting unexpectedly sent a native command");
  assert.deepEqual(errors, []);
  for (const [path, hash] of Object.entries(sourceHashes)) assert.equal(sha256(await readFile(join(root, path))), hash, `Source changed during qualification: ${path}; rerun the suite`);
  const screenshotHashes = Object.fromEntries(await Promise.all(screenshots.map(async (name) => [name, sha256(await readFile(join(output, name)))])));
  await writeFile(join(output, "manifest.json"), JSON.stringify({ status: "passed", fixture: "four independent intercepted control sources and runtimes, 100 sessions", realModelCalls: 0, screenshots, checks, hashes: { ...sourceHashes, ...screenshotHashes } }, null, 2) + "\n");
  console.log(`Four-host browser checks passed (${checks.length}): ${output}`);
} catch (error) {
  await screenshot("failure");
  await writeFile(join(output, "failure.txt"), String(error) + "\n" + errors.join("\n"));
  throw error;
} finally { await context.close(); await browser.close(); await vite.close(); }
