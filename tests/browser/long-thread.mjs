import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

// A disposable production-build qualification. All domain API/WS traffic is
// intercepted; this fixture cannot contact a host or spend model credits.
const root = resolve(import.meta.dirname, "../..");
const output = join(root, "receipts/long-thread", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function sourceFiles(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) files.push(...await sourceFiles(join(directory, item.name)));
    else files.push(join(directory, item.name));
  }
  return files;
}
const inputs = [join(root, "packages/native-errors/src/index.ts"), ...await sourceFiles(join(root, "apps/web/src")), join(root, "apps/web/vite.config.ts"), join(root, "apps/web/index.html"), join(root, "package.json"), join(root, "package-lock.json"), join(root, "LICENSE"), join(root, "THIRD_PARTY_NOTICES.md"), join(root, "apps/web/THIRD_PARTY_LICENSES.txt"), import.meta.filename].sort();
const hashes = Object.fromEntries(await Promise.all(inputs.map(async (path) => [relative(root, path), sha256(await readFile(path))])));
const fixtureTurns = 50_000;
const fixtureItems = fixtureTurns * 2 + 1;
const hugeOutput = "line: fixture output, not a real command or private transcript\n".repeat(35_000) + "END OF LARGE FIXTURE OUTPUT";
const itemAt = (index) => {
  if (index === fixtureItems - 1) return { turnId: "turn-49999", item: { type: "commandExecution", id: "huge-output", command: "Print disposable large fixture", status: "completed", aggregatedOutput: hugeOutput } };
  const turn = Math.floor(index / 2);
  return { turnId: `turn-${turn}`, item: index % 2 === 0
    ? { type: "userMessage", id: `user-${turn}`, content: [{ type: "text", text: `Turn ${turn}: review the disposable fixture and preserve native event order. ${"A little more context. ".repeat(turn % 7)}` }] }
    : { type: "agentMessage", id: `assistant-${turn}`, phase: "final_answer", text: `Reply ${turn}: the fixture contains no real session content.\n\n${turn % 3 === 0 ? "- One concrete observation\n- Another useful detail\n\n" : ""}${turn % 11 === 0 ? "```ts\nconst fixture = { ready: true };\n```\n\n" : ""}${"This paragraph provides variable-height content. ".repeat(turn % 13)}` } };
};
// Generate native pages outside the browser and outside measured interaction.
const pages = Array.from({ length: Math.ceil(fixtureItems / 100) }, (_, page) => {
  const offset = page * 100;
  const complete = offset + 100 >= fixtureItems;
  return { harness: "codex", vendorSessionId: "fixture-long-native", complete,
    ...(complete ? {} : { nextCursor: `offset:${offset + 100}` }),
    payload: { encoding: "native-json-images-v1", images: [], json: { data: Array.from({ length: Math.min(100, fixtureItems - offset) }, (_, index) => itemAt(offset + index)), nextCursor: complete ? null : `offset:${offset + 100}` } } };
});
await build({ configFile: join(root, "apps/web/vite.config.ts"), build: { outDir: join(output, "site"), sourcemap: false }, logLevel: "warn" });
const vite = await preview({ configFile: join(root, "apps/web/vite.config.ts"), build: { outDir: join(output, "site") }, preview: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "warn" });
const port = vite.httpServer.address().port;
const browser = await chromium.launch({ ...(process.env.LEO_TEST_CHROMIUM ? { executablePath: process.env.LEO_TEST_CHROMIUM } : {}), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const errors = [];
const checks = [];
const measurements = {};
page.on("pageerror", (error) => errors.push(error.message));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const authority = { realmId: id(1), controlNodeId: id(2), epochId: id(3) };
const timestamp = "2026-09-05T00:00:00.000Z";
function makeSession(n, title) {
  return { sessionId: id(n), runtimeNodeId: id(5), metadataAuthority: authority, catalogState: "open", catalogRevision: 1, archivedAt: null, harness: "codex", adapterScopeId: "fixture-codex", vendorSessionId: `fixture-${n}-native`, bindingRevision: 1, runtimeEpoch: id(6), cwd: "/work/disposable/long-thread-fixture", availability: "active", runtimeStatus: "idle", harnessSettings: { model: "fixture-model", mode: "default", effort: "medium" }, nativeSummary: { title }, launchProvenance: null, metadata: { revision: 1, values: { "agent.title": title }, keyRevisions: { "agent.title": 1 } }, createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, lastActivityAt: timestamp };
}
const session = makeSession(4, "50,000-turn disposable fixture");
const other = makeSession(14, "Switch cancellation fixture");
const runtime = { runtimeNodeId: id(5), name: "Disposable test host", presence: "online", reachability: "reachable", runtimeNodeBootId: id(7), capabilities: [], harnesses: [{ harness: "codex", available: true, capabilities: [] }] };
const source = { sourceId: "fixture", displayName: "Disposable test host", endpointId: "fixture", state: "selected", manifest: { coveredControlNodeIds: [id(2)] }, updatedAt: timestamp };
const profile = { providerId: "leo.local", profileId: "workspace", contractVersion: 1, requestSchemaHash: "a".repeat(64), implementationVersion: "1.0.0", harnesses: ["codex"], available: true, capabilities: [] };
const historyRequests = [];
let historyDelay = 100;
let continuedHistoryGate = null;
let eventSequence = 0;
const subscriptions = new Set();
await page.routeWebSocket("**/trpc", (socket) => socket.onMessage((message) => {
  if (message === "PING") return socket.send("PONG");
  for (const request of [JSON.parse(message)].flat()) {
    if (request.method === "subscription") {
      const subscription = { socket, id: request.id, input: request.params?.input };
      subscriptions.add(subscription);
      socket.send(JSON.stringify({ id: request.id, result: { type: "started" } }));
      socket.send(JSON.stringify({ id: request.id, result: { type: "data", data: { kind: "heartbeat", feedId: id(8), controlCursor: 0, authorityRefs: [authority] } } }));
    } else if (request.method === "subscription.stop") {
      for (const subscription of subscriptions) if (subscription.socket === socket && subscription.id === request.id) subscriptions.delete(subscription);
    }
  }
}));
function sendNative(nativeType, json) {
  const data = { kind: "native", sessionId: session.sessionId, harness: "codex", runtimeEpoch: session.runtimeEpoch, sequence: ++eventSequence, nativeType, ephemeral: false, provenance: { originControlNodeId: authority.controlNodeId, authority }, payload: { encoding: "native-json-images-v1", images: [], json: { threadId: session.vendorSessionId, ...json } } };
  for (const subscription of subscriptions) {
    // Match the selected-session subscription; the catalog watch does not need
    // native payloads. This is the same session filter the gateway enforces.
    if (subscription.input?.includeNative && subscription.input.sessions?.includes?.(session.sessionId)) subscription.socket.send(JSON.stringify({ id: subscription.id, result: { type: "data", data } }));
  }
}
await page.route("**/auth/check", (route) => route.fulfill({ status: 204, body: "" }));
await page.route("**/auth/session", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ method: "tailscale" }) }));
await page.route("**/trpc/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const paths = decodeURIComponent(url.pathname.slice("/trpc/".length)).split(",");
  const args = JSON.parse(request.method() === "POST" ? request.postData() ?? "{}" : url.searchParams.get("input") ?? "{}");
  const results = [];
  for (const [index, path] of paths.entries()) {
    const input = args[index];
    assert.equal(request.method(), "GET", `Unexpected mutation: ${path}`);
    let data;
    switch (path) {
      case "system.describe": data = { componentKind: "access-gateway", protocolVersion: 5 }; break;
      case "sources.list": data = [source]; break;
      case "controlNodes.list": data = [{ controlNodeId: id(2) }]; break;
      case "runtimeNodes.list": data = [runtime]; break;
      case "sessions.search": data = { sessions: [session, other], nextCursor: null }; break;
      case "harness.models": case "launchProfiles.models": data = [{ harness: "codex", id: "fixture-model", name: "Fixture model" }]; break;
      case "launchProfiles.list": data = [profile]; break;
      case "interactions.list": data = []; break;
      case "metadata.get": data = session.metadata; break;
      case "sessions.readNativeHistory": {
        if (input.request.includeTurns === false) {
          data = { harness: "codex", vendorSessionId: session.vendorSessionId, complete: true, payload: { encoding: "native-json-images-v1", images: [], json: { thread: { status: { type: "idle" }, turns: [] } } } };
          break;
        }
        historyRequests.push({ sessionId: input.sessionId, cursor: input.request.cursor ?? null, time: performance.now() });
        if (historyDelay) await new Promise((resolve) => setTimeout(resolve, historyDelay));
        if (input.sessionId === session.sessionId && input.request.cursor && continuedHistoryGate) await continuedHistoryGate;
        if (input.sessionId === other.sessionId) {
          data = { harness: "codex", vendorSessionId: other.vendorSessionId, complete: true, payload: { encoding: "native-json-images-v1", images: [], json: { data: [{ turnId: "other-turn", item: { type: "agentMessage", id: "other-message", phase: "final_answer", text: "A separate disposable conversation." } }], nextCursor: null } } };
        } else {
          assert.equal(input.request.limit, 100, "History requests must use bounded native pages");
          assert(!input.request.cursor || /^offset:\d+$/.test(input.request.cursor), "Opaque fixture cursor corrupted");
          const offset = input.request.cursor ? Number(input.request.cursor.slice(7)) : 0;
          assert.equal(offset % 100, 0);
          assert(pages[offset / 100], `Invalid fixture offset: ${offset}`);
          data = { ...pages[offset / 100], vendorSessionId: session.vendorSessionId };
        }
        break;
      }
      default: throw new Error(`Unexpected fixture procedure: ${path}`);
    }
    results.push({ result: { data } });
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(results) }).catch((error) => {
    // Abort is expected in the explicit cancellation cases.
    if (!/disposed|closed|canceled|cancelled|Invalid InterceptionId/i.test(String(error))) throw error;
  });
});
async function count() { return Number(await page.getByTestId("chat-transcript").getAttribute("data-total-entries")); }
async function waitCount(expected, timeout = 15_000) {
  await page.waitForFunction((expected) => Number(document.querySelector('[data-testid="chat-transcript"]')?.getAttribute("data-total-entries")) === expected, expected, { timeout });
}
async function boundedDOM(name) {
  const result = await page.evaluate(() => ({ mountedMessages: document.querySelectorAll('[data-testid="chat-message"]').length, allElements: document.querySelectorAll("*").length, totalItems: Number(document.querySelector('[data-testid="chat-transcript"]')?.getAttribute("data-total-entries")) }));
  assert.equal(result.mountedMessages, Math.min(200, result.totalItems), `${name}: expected the full bounded 200-message window: ${JSON.stringify(result)}`);
  assert(result.allElements < 3_000, `${name}: total DOM grew with history: ${JSON.stringify(result)}`);
  checks.push({ name, ...result });
}
async function scrollTo(fraction) {
  const transcript = page.getByTestId("chat-transcript");
  // A user wheel gesture also cancels in-progress follow-to-latest behavior.
  await transcript.hover();
  await page.mouse.wheel(0, fraction === 1 ? 200 : -200);
  await transcript.evaluate((element, fraction) => { element.scrollTop = fraction * (element.scrollHeight - element.clientHeight); }, fraction);
  await page.waitForTimeout(150);
}
async function startMetrics() {
  await page.evaluate(() => {
    const state = globalThis.__fixtureMetrics = { active: true, longTasks: [], frames: [], inputPaints: [], lastFrame: 0 };
    state.observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (state.active) state.longTasks.push(entry.duration); });
    state.observer.observe({ type: "longtask" });
    const frame = (now) => { if (!state.active) return; if (state.lastFrame) state.frames.push(now - state.lastFrame); state.lastFrame = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    state.listener = () => { const start = performance.now(); requestAnimationFrame(() => { if (state.active) state.inputPaints.push(performance.now() - start); }); };
    document.querySelector('[data-testid="prompt-input"]').addEventListener("input", state.listener);
  });
}
async function stopMetrics(name) {
  const result = await page.evaluate(() => {
    const state = globalThis.__fixtureMetrics;
    state.active = false; state.observer.disconnect();
    document.querySelector('[data-testid="prompt-input"]').removeEventListener("input", state.listener);
    const stats = (values) => { const sorted = [...values].sort((a,b) => a-b); return { count: sorted.length, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 }; };
    return { frames: stats(state.frames), inputPaints: stats(state.inputPaints), longTasks: stats(state.longTasks) };
  });
  measurements[name] = result;
  return result;
}
try {
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="chat-transcript"]')?.getAttribute("data-total-entries")) >= 200);
  assert(historyRequests.length >= 2, "Opening a giant conversation must automatically continue beyond its first native page");
  await boundedDOM("automatic initial history loading");
  checks.push({ name: "opening a session automatically scans bounded native pages toward latest", passed: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByTestId("history-pagination").waitFor();
  await page.getByTestId("prompt-input").fill("Draft while earlier history is still loading");
  const partialTranscript = await page.getByTestId("chat-transcript").boundingBox();
  assert(partialTranscript && partialTranscript.height >= 120, `Partial-history short-landscape transcript is only ${partialTranscript?.height}px`);
  const partialPrompt = await page.getByTestId("prompt-input").boundingBox();
  const partialSend = await page.getByTestId("send-button").boundingBox();
  assert(partialPrompt.y + partialPrompt.height <= partialSend.y + 1, "Partial-history landscape draft overlaps Send");
  assert(partialSend.y + partialSend.height <= 390, "Partial-history landscape Send is outside viewport");
  checks.push({ name: "partial native history leaves at least 120px conversation in short landscape", transcriptHeight: partialTranscript.height });
  await page.getByTestId("prompt-input").fill("");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("cancel-history-load").click();
  await page.getByTestId("load-all-history").waitFor();
  const stoppedRequests = historyRequests.length;
  const stoppedCount = await count();
  await page.waitForTimeout(350);
  assert.equal(historyRequests.length, stoppedRequests, "Cancellation continued fetching pages");
  assert.equal(await count(), stoppedCount, "Cancelled history response changed visible history");
  checks.push({ name: "automatic load cancellation stops requests and ignores late responses", loadedItems: stoppedCount });

  await page.getByTestId("load-more-history").click();
  await waitCount(stoppedCount + 100);
  await page.getByTestId("load-all-history").waitFor();
  const nextPageRequests = historyRequests.length;
  await page.waitForTimeout(350);
  assert.equal(historyRequests.length, nextPageRequests, "Next 100 continued into an automatic full scan after cancellation");
  assert.equal(await count(), stoppedCount + 100);
  checks.push({ name: "stopped automatic loading still allows one explicit bounded page", passed: true });

  await page.getByTestId("load-all-history").click();
  await page.waitForTimeout(150);
  await page.getByTestId("session-card").filter({ hasText: "Switch cancellation fixture" }).click();
  await waitCount(1);
  await page.getByTestId("chat-message").filter({ hasText: "A separate disposable conversation." }).waitFor();
  const switchedRequests = historyRequests.filter((item) => item.sessionId === session.sessionId).length;
  await page.waitForTimeout(350);
  assert.equal(historyRequests.filter((item) => item.sessionId === session.sessionId).length, switchedRequests, "Old binding continued fetching after switching");
  assert.equal(await count(), 1, "Old binding history polluted the selected session");
  checks.push({ name: "switching sessions cancels former history without cross-session rows", passed: true });
  historyDelay = 0;
  let releaseContinuedHistory;
  continuedHistoryGate = new Promise((resolve) => { releaseContinuedHistory = resolve; });
  const fullStartRequest = historyRequests.length;
  await page.getByTestId("session-card").filter({ hasText: "50,000-turn disposable fixture" }).click();
  await waitCount(100);
  await page.getByTestId("prompt-input").fill("");
  await startMetrics();
  const loadingStart = performance.now();
  continuedHistoryGate = null;
  releaseContinuedHistory();
  // Keep interaction active during import, not just after fixture ingestion.
  const loadingTyping = page.getByTestId("prompt-input").pressSequentially("Typing remains available while a very long thread loads.", { delay: 25 });
  await loadingTyping;
  await waitCount(fixtureItems, 120_000);
  measurements.loadMs = performance.now() - loadingStart;
  const loadMetrics = await stopMetrics("historyLoading");
  assert(loadMetrics.inputPaints.count >= 50, "History loading sampled too few keyboard events");
  assert(loadMetrics.inputPaints.p95 < 100 && loadMetrics.inputPaints.max < 250, `History import blocked input: ${JSON.stringify(loadMetrics)}`);
  assert(loadMetrics.longTasks.max < 250, `History import caused a task over 250ms: ${JSON.stringify(loadMetrics)}`);
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "Typing remains available while a very long thread loads.");
  const fullRequests = historyRequests.slice(fullStartRequest).filter((item) => item.sessionId === session.sessionId);
  assert.equal(fullRequests.length, pages.length, "Full history missed or replayed pages");
  assert.deepEqual(fullRequests.map((item) => item.cursor), pages.map((_, index) => index ? `offset:${index * 100}` : null));
  assert.equal(await page.getByTestId("history-pagination").count(), 0, "Complete history still presented as partial");
  await page.waitForFunction(() => {
    const transcript = document.querySelector('[data-testid="chat-transcript"]');
    const tail = transcript?.querySelector('[data-native-item-id="huge-output"]');
    if (!transcript || !tail?.checkVisibility({ contentVisibilityAuto: true })) return false;
    const viewport = transcript.getBoundingClientRect();
    const bounds = tail.getBoundingClientRect();
    return bounds.bottom > viewport.top && bounds.top < viewport.bottom && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 8;
  });
  checks.push({ name: "reselected 50,000-turn session automatically loads every native page and displays latest", turns: fixtureTurns, items: fixtureItems, pageRequests: fullRequests.length });
  await boundedDOM("all 100,001 items loaded");
  await scrollTo(0);
  await page.locator('[data-native-item-id="user-0"]').waitFor();
  await boundedDOM("first native turn remains accessible");
  await scrollTo(0.5);
  await boundedDOM("middle of the complete thread");
  await scrollTo(1);
  await page.locator('[data-native-item-id="huge-output"]').waitFor();
  await page.locator('[data-native-item-id="huge-output"] summary').click();
  await page.getByTestId("long-content-controls").waitFor();
  const outputBody = page.locator('[data-native-item-id="huge-output"] [data-testid="command-output"]');
  assert((await outputBody.textContent()).length <= 16_384, "Large output rendered the full native body");
  await page.getByTestId("long-content-controls").getByRole("button", { name: "Latest", exact: true }).click();
  assert((await outputBody.textContent()).endsWith("END OF LARGE FIXTURE OUTPUT"));
  assert((await outputBody.textContent()).length <= 16_384);
  checks.push({ name: "multi-megabyte output renders bounded parts with final bytes reachable", nativeBytes: Buffer.byteLength(hugeOutput), mountedCharacters: (await outputBody.textContent()).length });
  await boundedDOM("expanded multi-megabyte command output");

  await scrollTo(0.45);
  const anchorBefore = await page.getByTestId("chat-transcript").evaluate((element) => ({ top: element.scrollTop, first: element.querySelector('[data-testid="chat-message"]')?.getAttribute("data-entry-id") }));
  const beforeCompletionReads = historyRequests.length;
  await page.getByTestId("prompt-input").fill("");
  await startMetrics();
  const streamStart = performance.now();
  const typing = page.getByTestId("prompt-input").pressSequentially("An editable draft while thousands of native fragments stream.", { delay: 20 });
  let fragments = 0;
  for (let batch = 0; batch < 90; batch++) {
    if (batch === 0) sendNative("item/started", { turnId: "streamed-turn", item: { type: "agentMessage", id: "streamed-reply", text: "", phase: "commentary" } });
    for (let index = 0; index < 24; index++) { sendNative("item/agentMessage/delta", { turnId: "streamed-turn", itemId: "streamed-reply", delta: `chunk ${fragments++} ` }); }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  sendNative("item/completed", { turnId: "streamed-turn", item: { type: "agentMessage", id: "streamed-reply", text: "FINAL STREAMED FIXTURE REPLY", phase: "final_answer" } });
  sendNative("turn/completed", { turn: { id: "streamed-turn", status: "completed", items: [] } });
  await typing;
  await waitCount(fixtureItems + 1);
  await page.waitForTimeout(150);
  const streamMetrics = await stopMetrics("streamingWhileTyping");
  measurements.streaming = { fragments, elapsedMs: performance.now() - streamStart };
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "An editable draft while thousands of native fragments stream.");
  assert.equal(historyRequests.length, beforeCompletionReads, "A completed turn replayed native history");
  const anchorAfter = await page.getByTestId("chat-transcript").evaluate((element) => ({ top: element.scrollTop, first: element.querySelector('[data-testid="chat-message"]')?.getAttribute("data-entry-id") }));
  assert.equal(anchorAfter.first, anchorBefore.first, "Streaming pulled the reader away from older history");
  assert(Math.abs(anchorAfter.top - anchorBefore.top) < 100, "Streaming moved the older-history scroll anchor");
  assert(streamMetrics.inputPaints.count >= 50, "Input timing sampled too few real keyboard events");
  assert(streamMetrics.inputPaints.p95 < 100, `p95 input-to-paint exceeded 100ms: ${JSON.stringify(streamMetrics)}`);
  assert(streamMetrics.inputPaints.max < 250, `Input-to-paint exceeded 250ms: ${JSON.stringify(streamMetrics)}`);
  assert(streamMetrics.frames.p95 < 50, `p95 frame interval exceeded 50ms: ${JSON.stringify(streamMetrics)}`);
  assert(streamMetrics.longTasks.max < 250, `Streaming caused a blocking task over 250ms: ${JSON.stringify(streamMetrics)}`);
  await boundedDOM("streaming plus typing at 100,001 historical items");
  await page.getByTestId("jump-to-latest").click();
  await page.locator('[data-native-item-id="streamed-reply"]').filter({ hasText: "FINAL STREAMED FIXTURE REPLY" }).waitFor();
  checks.push({ name: "streaming keeps draft and older-history anchor, native completion does not reload history", fragments, passed: true });
  await page.getByTestId("prompt-input").fill("");
  await startMetrics();
  const concurrentTyping = page.getByTestId("prompt-input").pressSequentially("A draft stays editable while scrolling and receiving new output.", { delay: 25 });
  sendNative("item/started", { turnId: "scrolling-turn", item: { type: "agentMessage", id: "scrolling-reply", text: "", phase: "commentary" } });
  let scrollingStream = true;
  const concurrentStream = (async () => {
    while (scrollingStream) {
      for (let index = 0; index < 24; index++) sendNative("item/agentMessage/delta", { turnId: "scrolling-turn", itemId: "scrolling-reply", delta: "more disposable output " });
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  })();
  try {
    for (let step = 0; step < 10; step++) { await scrollTo(step / 9); await boundedDOM(`scrolling during native stream ${step + 1}`); }
    await concurrentTyping;
  } finally { scrollingStream = false; await concurrentStream; }
  sendNative("item/completed", { turnId: "scrolling-turn", item: { type: "agentMessage", id: "scrolling-reply", text: "SCROLLING STREAM FINISHED", phase: "final_answer" } });
  sendNative("turn/completed", { turn: { id: "scrolling-turn", status: "completed", items: [] } });
  await waitCount(fixtureItems + 2);
  const concurrentMetrics = await stopMetrics("streamingWhileScrollingAndTyping");
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "A draft stays editable while scrolling and receiving new output.");
  assert(concurrentMetrics.inputPaints.count >= 50, "Concurrent scroll/stream sampled too few keyboard events");
  assert(concurrentMetrics.inputPaints.p95 < 100 && concurrentMetrics.inputPaints.max < 250, `Concurrent scrolling and native output blocked input: ${JSON.stringify(concurrentMetrics)}`);
  assert(concurrentMetrics.frames.p95 < 50, `Concurrent scrolling/streaming p95 frame interval exceeded 50ms: ${JSON.stringify(concurrentMetrics)}`);
  assert(concurrentMetrics.longTasks.max < 250, `Concurrent scrolling and native output caused a task over 250ms: ${JSON.stringify(concurrentMetrics)}`);
  assert.equal(historyRequests.length, beforeCompletionReads, "Subsequent completed turn replayed history");
  await startMetrics();
  for (let step = 0; step < 20; step++) { await scrollTo((step % 10) / 9); await boundedDOM(`scroll sample ${step + 1}`); }
  const scrollMetrics = await stopMetrics("scrollingCompleteThread");
  assert(scrollMetrics.longTasks.max < 250, `Scrolling caused a blocking task over 250ms: ${JSON.stringify(scrollMetrics)}`);
  await page.screenshot({ path: join(output, "long-thread-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await scrollTo(1);
  await boundedDOM("100,001-item thread on mobile");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile horizontal overflow");
  const composer = await page.getByTestId("prompt-input").boundingBox();
  assert(composer && composer.y + composer.height <= 844, "Mobile composer fell outside the viewport");
  const mobileSend = await page.getByTestId("send-button").boundingBox();
  assert(composer.y + composer.height <= mobileSend.y + 1, "Wrapped stress-test draft overlaps mobile Send controls");
  assert(mobileSend.y + mobileSend.height <= 844, "Mobile Send fell outside viewport");
  await page.screenshot({ path: join(output, "long-thread-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  for (const [path, hash] of Object.entries(hashes)) assert.equal(sha256(await readFile(join(root, path))), hash, `Source changed during qualification: ${path}; rerun the suite`);
  const artifacts = ["long-thread-desktop.png", "long-thread-mobile.png"];
  const artifactHashes = Object.fromEntries(await Promise.all(artifacts.map(async (name) => [name, sha256(await readFile(join(output, name)))])));
  const buildHashes = Object.fromEntries(await Promise.all((await sourceFiles(join(output, "site"))).map(async (path) => [relative(join(output, "site"), path), sha256(await readFile(path))])));
  const manifest = { buildHashes, status: "passed", fixture: "intercepted production-build browser APIs; ascending native 100-item pages", realModelCalls: 0, viewport: { width: 1440, height: 900 }, browser: browser.version(), fixtureTurns, fixtureItems, checks, measurements, hashes, artifactHashes };
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", output, measurements }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(output, "failure.json"), JSON.stringify({ status: "failed", error: String(error), errors, measurements, checks, hashes }, null, 2) + "\n");
  throw error;
} finally { await context.close(); await browser.close(); await new Promise((resolve) => vite.httpServer.close(resolve)); }
