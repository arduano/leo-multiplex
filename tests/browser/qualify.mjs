import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { createServer } from "vite";

// Disposable browser-only fixture: all API/WS traffic is intercepted. No host,
// Codex process, auth home, provider, or model endpoint is contacted.
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
const sources = [...await sourceFiles("apps/web"), "package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "tests/browser/qualify.mjs"];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async (path) => [path, sha256(await readFile(join(root, path)))])));
const output = join(root, "receipts/browser", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: join(root, "apps/web/vite.config.ts"), server: { host: "127.0.0.1", port: 0, strictPort: false } });
await vite.listen();
const port = vite.httpServer.address().port;
const browser = await chromium.launch({ ...(process.env.LEO_TEST_CHROMIUM ? { executablePath: process.env.LEO_TEST_CHROMIUM } : {}), headless: true });
const context = await browser.newContext({ viewport: { width: 1720, height: 1180 }, reducedMotion: "reduce" });
// A Tailscale HTTP address has secure randomness but no HTTPS-only UUID/hash APIs.
await context.addInitScript(() => {
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined });
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined });
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const authority = { realmId: id(1), controlNodeId: id(2), epochId: id(3) };
const timestamp = "2026-09-05T00:00:00.000Z";
const session = { sessionId: id(4), runtimeNodeId: id(5), metadataAuthority: authority, catalogState: "open", catalogRevision: 1, archivedAt: null, harness: "codex", adapterScopeId: "fixture-codex", vendorSessionId: "fixture-native", bindingRevision: 1, runtimeEpoch: id(6), cwd: "/work/disposable/browser-fixture", availability: "active", runtimeStatus: "idle", harnessSettings: { model: "fixture-model", mode: "default", effort: "medium" }, nativeSummary: { title: "Review reconnect behavior" }, launchProvenance: null, metadata: { revision: 1, values: { "agent.title": "Review reconnect behavior", "fixture.note": "Disposable browser data" }, keyRevisions: { "agent.title": 1, "fixture.note": 1 } }, createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, lastActivityAt: timestamp };
const other = { ...session, sessionId: id(14), vendorSessionId: "other-fixture-native", nativeSummary: { title: "Another disposable agent" }, metadata: { revision: 1, values: { "agent.title": "Another disposable agent" }, keyRevisions: { "agent.title": 1 } } };
let showOther = false;
const commands = [];
const runtime = { runtimeNodeId: id(5), name: "Disposable test host", presence: "online", reachability: "reachable", runtimeNodeBootId: id(7), capabilities: [], harnesses: [{ harness: "codex", available: true, capabilities: [] }] };
const source = { sourceId: "fixture", displayName: "Disposable test host", endpointId: "fixture", state: "selected", manifest: { coveredControlNodeIds: [id(2)] }, updatedAt: timestamp };
const profile = { providerId: "leo.local", profileId: "workspace", contractVersion: 1, requestSchemaHash: "a".repeat(64), implementationVersion: "1.0.0", harnesses: ["codex"], available: true, capabilities: [] };
let online = true;
let login = true;
let gateway = true;
let empty = false;
let recovery = "missing";
const launches = [];
const mutations = [];
const checks = [];
const screenshots = [];
await page.routeWebSocket("**/trpc", (socket) => socket.onMessage((message) => {
  if (message === "PING") return socket.send("PONG");
  for (const request of [JSON.parse(message)].flat()) {
    if (request.method === "subscription") {
      socket.send(JSON.stringify({ id: request.id, result: { type: "started" } }));
      socket.send(JSON.stringify({ id: request.id, result: { type: "data", data: { kind: "heartbeat", feedId: id(8), controlCursor: 0, authorityRefs: [authority] } } }));
    }
  }
}));
await page.route("**/auth/check", (route) => route.fulfill({ status: login ? 204 : 401, body: "" }));
await page.route("**/auth/session", (route) => route.fulfill({ status: login ? 200 : 401, contentType: "application/json", body: JSON.stringify({ method: "tailscale" }) }));
await page.route("**/trpc/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const paths = decodeURIComponent(url.pathname.slice("/trpc/".length)).split(",");
  const inputs = JSON.parse(request.method() === "POST" ? request.postData() ?? "{}" : url.searchParams.get("input") ?? "{}");
  if (!gateway) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify([{ error: { message: "Disposable gateway offline", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 503 } } }]) });
  const results = [];
  for (const [index, path] of paths.entries()) {
    const input = inputs[index];
    if (request.method() === "POST") mutations.push(path);
    let data;
    switch (path) {
      case "system.describe": data = { componentKind: "access-gateway", protocolVersion: 5 }; break;
      case "sources.list": data = [{ ...source, state: online ? "selected" : "unavailable", manifest: online ? source.manifest : null }]; break;
      case "controlNodes.list": data = online ? [{ controlNodeId: id(2) }] : []; break;
      case "runtimeNodes.list": data = online ? [runtime] : []; break;
      case "sessions.search": data = { sessions: online && !empty ? showOther ? [session, other] : [session] : [], nextCursor: null }; break;
      case "harness.models":
      case "launchProfiles.models": data = [{ harness: "codex", id: "fixture-model", name: "Fixture model" }]; break;
      case "launchProfiles.list": data = [profile]; break;
      case "interactions.list": data = []; break;
      case "metadata.get": data = session.metadata; break;
      case "sessions.readNativeHistory":
        if (input.sessionId === other.sessionId) {
          data = { harness: "codex", vendorSessionId: other.vendorSessionId, complete: true, payload: { encoding: "native-json-images-v1", images: [], json: { data: [{ turnId: "other-turn", item: { type: "agentMessage", id: "other-reply", phase: "final_answer", text: "A separate disposable conversation." } }], nextCursor: null } } };
          break;
        }
        data = { harness: "codex", vendorSessionId: session.vendorSessionId, complete: true, payload: { encoding: "native-json-images-v1", images: [], json: { data: [{ turnId: "turn-fixture", item: { type: "userMessage", id: "user-fixture", content: [{ type: "text", text: "Check that my draft survives a host reconnect." }] } }, { turnId: "turn-fixture", item: { type: "agentMessage", id: "assistant-fixture", text: "The conversation remains visible while the host reconnects.\n\n- Preserve your draft\n- Keep stale sessions labeled\n- Resume actions after reconnection\n\n```text\n/work/disposable/long-directory-name/verification/unchanged-operation-identity\n```" } }], nextCursor: null } } }; break;
      case "sessions.execute":
        commands.push(input);
        if (commands.length === 1) return route.abort("failed");
        data = { commandId: input.commandId, payloadHash: input.payloadHash, sessionId: input.sessionId, runtimeNodeId: input.runtimeNodeId, state: "succeeded", request: input.request, createdAt: timestamp, updatedAt: timestamp };
        break;
      case "launches.create":
        launches.push(input);
        if (launches.length === 1) return route.abort("failed");
        data = { state: "accepted", launchId: input.launchId, sessionId: input.sessionId }; recovery = "accepted"; break;
      case "launches.get": data = recovery === "missing" ? null : { state: recovery, launchId: input }; break;
      default: throw new Error(`Unexpected fixture procedure: ${path}`);
    }
    results.push({ result: { data } });
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(results) });
});
async function waitEnabled(testId, enabled) {
  await page.waitForFunction(({ testId, enabled }) => {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    return element && element.disabled === !enabled;
  }, { testId, enabled });
}
async function refresh() { await page.getByTestId("refresh-workspace").click(); }
async function screenshot(name) {
  const file = `${name}.png`;
  await page.screenshot({ path: join(output, file), fullPage: true });
  screenshots.push(file);
}
async function axe(name) {
  const result = await new AxeBuilder({ page }).analyze();
  const severe = result.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
  assert.equal(severe.length, 0, `${name}: ${JSON.stringify(severe.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })))}`);
  checks.push({ name, seriousOrCriticalViolations: severe.length });
}
try {
  await page.goto(`http://127.0.0.1:${port}`);
  await waitEnabled("prompt-input", true);
  await page.locator('[data-entry-id="codex:user-fixture"]').filter({ hasText: "Check that my draft survives a host reconnect." }).waitFor();
  await page.locator('[data-entry-id="codex:assistant-fixture"]').filter({ hasText: "The conversation remains visible while the host reconnects." }).waitFor();
  assert.equal(await page.getByTestId("chat-message").count(), 2, "Initial native history must be visible before responsive qualification");
  checks.push({ name: "initial native history renders both user and assistant messages", passed: true });
  await page.waitForFunction(() => document.querySelector('[data-testid="session-health"]')?.textContent === "Live");
  checks.push({ name: "native stream is live after the development lifecycle remount", passed: true });
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"]').setInputFiles({ name: "tailscale-http.png", mimeType: "image/png", buffer: image });
  await page.getByRole("button", { name: "Remove tailscale-http.png" }).waitFor();
  await page.getByRole("button", { name: "Remove tailscale-http.png" }).click();
  checks.push({ name: "image attachment without HTTPS-only crypto APIs", passed: true });
  await page.getByTestId("connection-menu-button").click();
  await page.getByText("Connected through Tailscale", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Sign out", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  checks.push({ name: "Tailscale account menu identifies access without a Cloudflare logout", passed: true });
  await page.getByTestId("prompt-input").fill("A draft that must survive reconnects");
  for (const [width, height] of [[1720,1180],[1440,900],[1024,768],[768,1024],[390,844],[844,390]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}x${height}`);
    const prompt = await page.getByTestId("prompt-input").boundingBox();
    assert(prompt && prompt.y + prompt.height <= height, `Composer outside viewport at ${width}x${height}`);
    const transcript = await page.getByTestId("chat-transcript").boundingBox();
    assert(transcript && transcript.height >= 120, `Conversation has less than 120px at ${width}x${height}`);
    assert(await page.getByTestId("chat-message").count() > 0, `Conversation is empty at ${width}x${height}`);
    await screenshot(`${width}x${height}`);
    await axe(`${width}x${height}`);
    if (width < 960 || (width < 1280 && height < 500)) {
      await page.getByTestId("agents-sheet-button").click();
      await page.getByTestId("session-card").waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector('[data-testid="agents-sheet-button"]') === document.activeElement);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const originalDraft = await page.getByTestId("prompt-input").inputValue();
  await page.getByTestId("prompt-input").fill("One line");
  const oneLineHeight = (await page.getByTestId("prompt-input").boundingBox()).height;
  const wrappedDraft = "A deliberately wrapped mobile draft should remain readable while the Send button stays below the text and every line is reachable without any overlay.";
  await page.getByTestId("prompt-input").fill(wrappedDraft);
  const wrappedBox = await page.getByTestId("prompt-input").boundingBox();
  const sendBox = await page.getByTestId("send-button").boundingBox();
  assert(wrappedBox.height > oneLineHeight, "Mobile draft does not expand for wrapped text");
  assert(wrappedBox.y + wrappedBox.height <= sendBox.y + 1, "Mobile wrapped draft overlaps Send controls");
  await page.getByTestId("prompt-input").press("Control+End");
  const draftGeometry = await page.getByTestId("prompt-input").evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, caret: element.selectionEnd, length: element.value.length }));
  assert.equal(draftGeometry.caret, wrappedDraft.length);
  assert(draftGeometry.scrollHeight <= draftGeometry.clientHeight + draftGeometry.scrollTop + 2, "End of mobile wrapped draft is unreachable");
  await screenshot("mobile-wrapped-draft");
  checks.push({ name: "wrapped mobile draft expands without overlapping controls and its final line is reachable", oneLineHeight, wrappedHeight: wrappedBox.height });
  await page.getByTestId("prompt-input").fill(originalDraft);
  await page.setViewportSize({ width: 1720, height: 1180 });
  online = false; await refresh();
  await page.getByTestId("stale-session-notice").waitFor();
  await waitEnabled("prompt-input", false);
  assert.equal(await page.getByTestId("session-card").count(), 1);
  assert.equal(await page.getByTestId("session-card").getAttribute("data-stale"), "true");
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "A draft that must survive reconnects");
  await page.getByTestId("right-pane-toggle").click();
  await page.getByTestId("metadata-json").fill('{"agent.title":"Unsaved stale draft"}');
  await waitEnabled("metadata-save", false);
  assert.equal(mutations.length, 0);
  await screenshot("stale-host"); await axe("stale-host");
  online = true; await refresh(); await waitEnabled("prompt-input", true);
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "A draft that must survive reconnects");
  await waitEnabled("metadata-save", true);
  checks.push({ name: "host reconnect retains rows and drafts without mutations", passed: true });

  gateway = false; await refresh(); await waitEnabled("prompt-input", false);
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "A draft that must survive reconnects");
  gateway = true; await refresh(); await waitEnabled("prompt-input", true);
  checks.push({ name: "gateway reconnect preserves workspace", passed: true });
  login = false; await refresh(); await waitEnabled("prompt-input", false);
  await page.getByText("Your sign-in expired.", { exact: false }).waitFor();
  await screenshot("expired-login");
  login = true; await refresh(); await waitEnabled("prompt-input", true);

  showOther = true; await refresh();
  await page.getByTestId("session-card").filter({ hasText: "Another disposable agent" }).waitFor();
  await page.getByTestId("prompt-input").fill("Draft belonging to the first agent");
  await page.locator('input[type="file"]').setInputFiles({ name: "retained-draft.png", mimeType: "image/png", buffer: image });
  await page.getByRole("button", { name: "Remove retained-draft.png" }).waitFor();
  await page.getByTestId("session-card").filter({ hasText: "Another disposable agent" }).click();
  await page.locator('[data-entry-id="codex:other-reply"]').waitFor();
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "");
  assert.equal(await page.getByTestId("image-attachments").count(), 0);
  await page.getByTestId("prompt-input").fill("An independent second draft");
  await page.getByTestId("session-card").filter({ hasText: "Review reconnect behavior" }).click();
  await page.locator('[data-entry-id="codex:user-fixture"]').waitFor();
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "Draft belonging to the first agent");
  await page.getByRole("button", { name: "Remove retained-draft.png" }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="image-attachments"] img')].some((image) => image.complete && image.naturalWidth > 0));
  await page.getByRole("button", { name: "Remove retained-draft.png" }).click();
  checks.push({ name: "switching bindings retains independent drafts and usable image previews", passed: true });
  await page.getByTestId("prompt-input").fill("Dispatch this exact command once");
  await page.getByTestId("send-button").evaluate((button) => { button.click(); button.click(); });
  await page.getByTestId("reconcile-command").waitFor();
  assert.equal(commands.length, 1, "Synchronous repeated submit dispatched duplicate commands");
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "Dispatch this exact command once");
  await page.getByTestId("session-card").filter({ hasText: "Another disposable agent" }).click();
  await page.locator('[data-entry-id="codex:other-reply"]').waitFor();
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "An independent second draft");
  assert.equal(await page.getByTestId("reconcile-command").count(), 0);
  await page.getByTestId("session-card").filter({ hasText: "Review reconnect behavior" }).click();
  await page.getByTestId("reconcile-command").waitFor();
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "Dispatch this exact command once");
  await waitEnabled("send-button", false);
  assert.equal(commands.length, 1, "Switching retried an uncertain command automatically");
  await page.getByTestId("reconcile-command").evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector('[data-testid="prompt-input"]')?.value === "");
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1], commands[0], "Reconciliation changed the original command envelope");
  assert.equal(await page.getByTestId("reconcile-command").count(), 0);
  checks.push({ name: "duplicate command dispatch is fenced and lost replies retain exact envelope across session switches", passed: true });
  showOther = false; await refresh();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-card"]').length === 1);

  await page.getByTestId("spawn-button").click();
  await page.getByTestId("spawn-cwd-input").fill("/work/disposable/new-session");
  await page.getByTestId("spawn-title-input").fill("Recover this exact launch");
  await waitEnabled("spawn-submit", true);
  await page.getByTestId("spawn-form").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await page.getByTestId("spawn-retry").waitFor();
  await waitEnabled("spawn-cwd-input", false);
  await screenshot("ambiguous-launch"); await axe("ambiguous-launch");
  await page.keyboard.press("Escape");
  await page.getByTestId("spawn-button").click();
  await page.getByTestId("spawn-retry").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="spawn-status"]')?.textContent?.includes("Launch accepted"));
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[1], launches[0]);
  assert.equal(new Set(launches.map((launch) => launch.launchId)).size, 1);
  checks.push({ name: "ambiguous launch retry preserves exact operation across dialog close", passed: true });
  recovery = "failed";
  await waitEnabled("spawn-submit", true);
  assert.equal(await page.getByTestId("spawn-retry").count(), 0);
  await waitEnabled("spawn-cwd-input", true);
  checks.push({ name: "settled launch unlocks a subsequent operation", passed: true });
  await page.keyboard.press("Escape");
  empty = true; await refresh();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-card"]').length === 0);
  checks.push({ name: "fresh authority removal clears stale row", passed: true });
  assert.deepEqual(errors, []);
  for (const [path, hash] of Object.entries(sourceHashes)) assert.equal(sha256(await readFile(join(root, path))), hash, `Source changed during qualification: ${path}; rerun the suite`);
  const screenshotHashes = Object.fromEntries(await Promise.all(screenshots.map(async (name) => [name, sha256(await readFile(join(output, name)))])));
  const hashes = { ...sourceHashes, ...screenshotHashes };
  await writeFile(join(output, "manifest.json"), JSON.stringify({ status: "passed", fixture: "intercepted browser-only APIs", realModelCalls: 0, screenshots, checks, hashes }, null, 2) + "\n");
  console.log(`Browser checks passed: ${output}`);
} catch (error) {
  await screenshot("failure");
  await writeFile(join(output, "failure.txt"), String(error) + "\n" + errors.join("\n"));
  throw error;
} finally { await context.close(); await browser.close(); await vite.close(); }
