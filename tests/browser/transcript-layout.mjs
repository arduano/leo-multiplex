import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

// A disposable production-build qualification. All domain API/WS traffic is
// intercepted; this fixture cannot contact a host or spend model credits.
const root = resolve(import.meta.dirname, "../..");
const output = join(root, "receipts/transcript-layout", new Date().toISOString().replaceAll(":", "-"));
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
const fixtureTurns = 400;
const fixtureItems = fixtureTurns * 2 + 1;
const hugeOutput = "line: disposable expanded output\n".repeat(800) + "END OF LARGE FIXTURE OUTPUT";
const itemAt = (index) => {
  const turnId = `turn-${Math.floor(index / 2)}`;
  if (index === fixtureItems - 1) return { turnId, item: { type: "commandExecution", id: "huge-output", command: "Print disposable large fixture", status: "completed", aggregatedOutput: hugeOutput } };
  if (index % 7 === 0) return { turnId, item: { type: "commandExecution", id: `tool-${index}`, command: `Fixture operation ${index}`, status: "completed", aggregatedOutput: "disposable command output\n".repeat(3 + index % 60) } };
  if (index % 5 === 0) return { turnId, item: { type: "userMessage", id: `user-${index}`, content: [{ type: "text", text: `Fixture request ${index}. ${"Wrapping prose for the narrow layout. ".repeat(1 + index % 19)}` }] } };
  return { turnId, item: { type: "agentMessage", id: `assistant-${index}`, phase: "final_answer", text: [
    `### Fixture response ${index}`,
    "Variable paragraph height. ".repeat(1 + index % 23),
    index % 2 === 0 ? Array.from({ length: 2 + index % 17 }, (_, n) => `- List item ${n}: measured Markdown differs from a plain-text preview.`).join("\n") : "",
    index % 3 === 0 ? "```ts\n" + "const fixture = { layout: 'variable' };\n".repeat(2 + index % 13) + "```" : "",
    index % 4 === 0 ? "| Field | Value |\n| --- | --- |\n" + "| Disposable | A wrapping cell with a longer value |\n".repeat(2 + index % 9) : "",
    index % 11 === 0 ? "> A blockquote has a different measured shape from its plain-text source.\n\n".repeat(3) : "",
  ].filter(Boolean).join("\n\n") } };
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
const session = makeSession(4, "Variable-height layout fixture");
const other = makeSession(14, "Switch cancellation fixture");
const runtime = { runtimeNodeId: id(5), name: "Disposable test host", presence: "online", reachability: "reachable", runtimeNodeBootId: id(7), capabilities: [], harnesses: [{ harness: "codex", available: true, capabilities: [] }] };
const source = { sourceId: "fixture", displayName: "Disposable test host", endpointId: "fixture", state: "selected", manifest: { coveredControlNodeIds: [id(2)] }, updatedAt: timestamp };
const profile = { providerId: "leo.local", profileId: "workspace", contractVersion: 1, requestSchemaHash: "a".repeat(64), implementationVersion: "1.0.0", harnesses: ["codex"], available: true, capabilities: [] };
const historyRequests = [];
const unexpectedRequests = [];
let historyDelay = 25;
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
  const data = { kind: "native", sessionId: session.sessionId, harness: "codex", runtimeEpoch: session.runtimeEpoch, sequence: ++eventSequence, nativeType, ephemeral: false, provenance: { originControlNodeId: authority.controlNodeId, authority }, payload: { encoding: "native-json-images-v1", images: [], json } };
  for (const subscription of subscriptions) {
    // Match the selected-session subscription; the catalog watch does not need
    // native payloads. This is the same session filter the gateway enforces.
    if (subscription.input?.includeNative && subscription.input.sessions?.includes?.(session.sessionId)) subscription.socket.send(JSON.stringify({ id: subscription.id, result: { type: "data", data } }));
  }
}
await page.route("**/*", async (route) => {
  if (new URL(route.request().url()).origin === `http://127.0.0.1:${port}`) return route.continue();
  unexpectedRequests.push(route.request().url());
  await route.abort("blockedbyclient");
});
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
async function waitCount(expected) {
  await page.waitForFunction((expected) => Number(document.querySelector('[data-testid="chat-transcript"]')?.getAttribute("data-total-entries")) === expected, expected);
}
async function settle(frames = 8) {
  await page.evaluate((frames) => new Promise((resolve) => {
    const next = () => --frames > 0 ? requestAnimationFrame(next) : resolve();
    requestAnimationFrame(next);
  }), frames);
}
async function snapshot() {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="chat-transcript"]');
    const bounds = viewport.getBoundingClientRect();
    const entries = [...viewport.querySelectorAll('[data-testid="chat-message"]')];
    // content-visibility:auto retains stale child rectangles while it skips
    // painting their ancestor. Assert geometry only for actually drawn rows.
    const boxes = entries.filter((entry) => entry.checkVisibility({ contentVisibilityAuto: true })).map((entry) => {
      const box = entry.getBoundingClientRect();
      return { id: entry.dataset.entryId, top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    }).filter((box) => box.bottom > bounds.top && box.top < bounds.bottom && box.bottom - box.top > 0 && box.right - box.left > 0);
    const overlaps = [];
    for (let first = 0; first < boxes.length; first++) {
      for (let second = first + 1; second < boxes.length; second++) {
        const a = boxes[first]; const b = boxes[second];
        const height = Math.min(a.bottom, b.bottom, bounds.bottom) - Math.max(a.top, b.top, bounds.top);
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (height > 1 && width > 1) overlaps.push({ first: a.id, second: b.id, height, width });
      }
    }
    return { total: Number(viewport.dataset.totalEntries), mounted: entries.length, visible: boxes.length, scrollTop: viewport.scrollTop,
      viewport: { top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height }, overlaps,
      duplicateIds: entries.length - new Set(entries.map((entry) => entry.dataset.entryId)).size,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
}
async function assertLayout(name, frames = 8) {
  await settle(frames);
  const result = await snapshot();
  measurements.samples = (measurements.samples ?? 0) + 1;
  measurements.maximumMounted = Math.max(measurements.maximumMounted ?? 0, result.mounted);
  measurements.minimumVisible = Math.min(measurements.minimumVisible ?? Infinity, result.visible);
  assert.equal(result.mounted, Math.min(200, result.total), `${name}: bounded 200-message window changed: ${JSON.stringify(result)}`);
  assert.equal(result.duplicateIds, 0, `${name}: duplicate native items mounted`);
  assert.equal(result.horizontalOverflow, false, `${name}: document overflows horizontally`);
  // A scroll-thumb jump can precede React's new range commit by one frame.
  // It must never paint overlapping content; the settled range must be visible.
  if (frames > 1) assert(result.visible > 0, `${name}: viewport contains no rendered messages: ${JSON.stringify(result)}`);
  assert.deepEqual(result.overlaps, [], `${name}: visible message rectangles overlap: ${JSON.stringify(result)}`);
  checks.push({ name, mounted: result.mounted, visible: result.visible, passed: true });
}
async function scrollTo(fraction, settled = true) {
  const transcript = page.getByTestId("chat-transcript");
  await transcript.evaluate((element, fraction) => {
    // Match an actual wheel's intent before jumping the native scroll thumb.
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: fraction === 1 ? 200 : -200, bubbles: true }));
    element.scrollTop = fraction * (element.scrollHeight - element.clientHeight);
  }, fraction);
  if (settled) await settle();
}
async function visibleTool() {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="chat-transcript"]').getBoundingClientRect();
    const entries = [...document.querySelectorAll('[data-role="tool"]')];
    return entries.find((entry) => { const box = entry.getBoundingClientRect(); return box.top >= viewport.top && box.bottom < viewport.bottom; })?.dataset.entryId;
  });
}
const artifacts = [];
async function screenshot(name) {
  await page.screenshot({ path: join(output, name), fullPage: true });
  artifacts.push(name);
}
try {
  await page.goto(`http://127.0.0.1:${port}`);
  await waitCount(100);
  await assertLayout("initial page with varied Markdown heights");

  // A live item is observed before older native pages containing that same ID.
  // Reconciliation must move its key into history without a duplicate or stale
  // indexed measurement being applied to a different row.
  const reconciled = itemAt(450);
  sendNative("item/completed", { turnId: reconciled.turnId, item: reconciled.item });
  await waitCount(101);
  await assertLayout("live item before its historical position is known");
  await page.getByTestId("load-all-history").click();
  await waitCount(fixtureItems);
  assert.equal(historyRequests.length, pages.length);
  await assertLayout("native history reconciles the earlier live item by ID");

  const jumps = [0, 0.95, 0.1, 0.9, 0.2, 0.8, 0.35, 0.65, 0.48, 0.52, 1, 0];
  for (const [index, fraction] of jumps.entries()) {
    await scrollTo(fraction, false);
    await assertLayout(`first frame after large scroll direction change ${index + 1}`, 1);
    await assertLayout(`large scroll direction change ${index + 1}`);
  }
  // Repeated small oscillations cross rich/plain and measured/unmeasured edges.
  await scrollTo(0.45);
  for (let index = 0; index < 32; index++) {
    await page.getByTestId("chat-transcript").evaluate((element, index) => { element.scrollTop += index % 2 === 0 ? 660 : -470; }, index);
    await assertLayout(`first frame after small direction reversal ${index + 1}`, 1);
    await assertLayout(`small direction reversal ${index + 1}`);
  }
  await screenshot("layout-desktop.png");

  for (const size of [{ width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 844, height: 390 }, { width: 1720, height: 1180 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await assertLayout(`width reflow at ${size.width} by ${size.height}`);
    await scrollTo(0.78);
    await assertLayout(`previously measured rows after width reflow ${size.width}`);
    if (size.width === 390) await screenshot("layout-phone.png");
  }

  await scrollTo(1);
  const outputRow = page.locator('[data-entry-id="codex:huge-output"]');
  await outputRow.locator("summary").click();
  await assertLayout("expand tool at tail");
  await screenshot("layout-expanded-tool.png");
  await outputRow.getByRole("button", { name: "Latest", exact: true }).click();
  await assertLayout("change expanded tool body part");
  await scrollTo(0.2);
  await assertLayout("leave expanded tail tool");
  await scrollTo(1);
  assert.equal(await outputRow.locator("details").getAttribute("open"), "", "Expanded state was lost on virtual remount");
  await assertLayout("return to expanded tail tool");
  await outputRow.locator("summary").click();
  await assertLayout("collapse tool after virtual remount");
  let expandedMiddle = 0;
  for (let index = 0; index < 12 && expandedMiddle < 3; index++) {
    await scrollTo(0.25 + index * 0.04);
    const entryId = await visibleTool();
    if (!entryId) continue;
    const summary = page.locator(`[data-entry-id="${entryId}"] summary`);
    await summary.click();
    await assertLayout(`expand visible historical tool ${++expandedMiddle}`);
    await summary.click();
    await assertLayout(`collapse visible historical tool ${expandedMiddle}`);
  }
  assert(expandedMiddle >= 1, "Fixture did not exercise a historical tool expansion");

  sendNative("item/started", { turnId: "streamed-turn", item: { type: "agentMessage", id: "streamed-reply", text: "", phase: "commentary" } });
  await waitCount(fixtureItems + 1);
  let streaming = true;
  const stream = (async () => {
    let index = 0;
    while (streaming) {
      sendNative("item/agentMessage/delta", { turnId: "streamed-turn", itemId: "streamed-reply", delta: `\n\n### Output ${++index}\n- Disposable streaming item\n- Another measured Markdown row\n` });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  })();
  try {
    for (const [index, fraction] of [1, 0.4, 0.7, 1, 0.2, 0.8, 1, 0.5].entries()) {
      await scrollTo(fraction);
      await assertLayout(`streaming during scroll ${index + 1}`);
    }
  } finally { streaming = false; await stream; }
  sendNative("item/completed", { turnId: "streamed-turn", item: { type: "agentMessage", id: "streamed-reply", text: "Finished disposable streaming reply.", phase: "final_answer" } });
  sendNative("turn/completed", { turn: { id: "streamed-turn", status: "completed", items: [] } });
  await scrollTo(1);
  await assertLayout("streaming row shrinks on native final replacement");
  await screenshot("layout-final.png");

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  for (const [path, hash] of Object.entries(hashes)) assert.equal(sha256(await readFile(join(root, path))), hash, `Source changed during qualification: ${path}; rerun the suite`);
  const artifactHashes = Object.fromEntries(await Promise.all(artifacts.map(async (name) => [name, sha256(await readFile(join(output, name)))])));
  const buildHashes = Object.fromEntries(await Promise.all((await sourceFiles(join(output, "site"))).map(async (path) => [relative(join(output, "site"), path), sha256(await readFile(path))])));
  const manifest = { status: "passed", fixture: "intercepted disposable production-build APIs; variable-height Markdown, tools, streaming, and native page reconciliation", realModelCalls: 0, browser: browser.version(), fixtureItems, checks, measurements, hashes, buildHashes, artifactHashes };
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const checksums = ["manifest.json", ...artifacts];
  await writeFile(join(output, "SHA256SUMS"), (await Promise.all(checksums.map(async (name) => `${sha256(await readFile(join(output, name)))}  ${name}`))).join("\n") + "\n");
  console.log(JSON.stringify({ status: "passed", output, checks: checks.length, measurements }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(output, "failure.json"), JSON.stringify({ status: "failed", error: String(error), layout: await snapshot().catch(() => null), errors, measurements, checks, hashes }, null, 2) + "\n");
  throw error;
} finally { await context.close(); await browser.close(); await new Promise((resolve) => vite.httpServer.close(resolve)); }
