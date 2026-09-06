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
const sources = [...await sourceFiles("apps/web"), ...await sourceFiles("packages/native-errors"), ...await sourceFiles("packages/session-activity"), "package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "tests/browser/copilot-yolo.mjs"];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async (path) => [path, sha256(await readFile(join(root, path)))])));
const output = join(root, "receipts/browser-copilot-yolo", new Date().toISOString().replaceAll(":", "-"));
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
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const timestamp = "2026-09-06T00:00:00.000Z";
const authority = { realmId: id(1), controlNodeId: id(2), epochId: id(3) };
const capability = { name: "permissions.mode", version: "v1" };
const runtime = { runtimeNodeId: id(4), name: "Disposable corporate Windows host", presence: "online", reachability: "reachable", runtimeNodeBootId: id(5), capabilities: [], harnesses: [{ harness: "copilot", available: true, capabilities: [capability] }] };
const session = { sessionId: id(6), runtimeNodeId: runtime.runtimeNodeId, metadataAuthority: authority, catalogState: "open", catalogRevision: 1, archivedAt: null,
  harness: "copilot", adapterScopeId: "disposable-copilot", vendorSessionId: "disposable-native", bindingRevision: 1, runtimeEpoch: id(7),
  cwd: "C:\\work\\disposable\\permission-fixture", availability: "active", runtimeStatus: "idle",
  harnessSettings: { model: "fixture-model", mode: "interactive", copilotPermissions: { mode: "manual" } }, nativeSummary: null, launchProvenance: null,
  metadata: { revision: 1, values: { "agent.title": "Review Copilot permissions" }, keyRevisions: { "agent.title": 1 } }, createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, lastActivityAt: timestamp };
const source = { sourceId: "fixture-source", displayName: runtime.name, endpointId: "fixture-endpoint", state: "selected", manifest: { coveredControlNodeIds: [authority.controlNodeId] }, updatedAt: timestamp };
const model = { harness: "copilot", id: "fixture-model", name: "Disposable image model", native: { id: "fixture-model", name: "Disposable image model", capabilities: { supports: { vision: true }, limits: { vision: { supported_media_types: ["image/png"], max_prompt_images: 10, max_prompt_image_size: 5_242_880 } } } } };
const interaction = (n, requestType, json) => ({ interactionId: id(n), sessionId: session.sessionId, runtimeEpoch: session.runtimeEpoch, harness: "copilot", state: "pending", requestType, payload: { encoding: "native-json-images-v1", images: [], json }, createdAt: timestamp, updatedAt: timestamp });
const permission = interaction(20, "permission", { permissionRequest: { kind: "write", intention: "Write the disposable fixture output" } });
const question = interaction(21, "userInput", { request: { question: "Which disposable output should I review?", choices: ["Summary", "Details"] } });
let pendingInteractions = [permission, question];
let online = true;
let behavior = "succeeded";
let releaseAcknowledgment;
const commands = [];
const mutations = [];
const procedures = [];
const receipts = new Map();
const checks = [];
const screenshots = [];
const subscriptions = new Set();
let controlSequence = 0;
await page.routeWebSocket("**/trpc", socket => socket.onMessage(message => {
  if (message === "PING") return socket.send("PONG");
  for (const request of [JSON.parse(message)].flat()) {
    if (request.method === "subscription") {
      subscriptions.add({ socket, id: request.id, input: request.params?.input });
      socket.send(JSON.stringify({ id: request.id, result: { type: "started" } }));
      socket.send(JSON.stringify({ id: request.id, result: { type: "data", data: { kind: "heartbeat", feedId: id(8), controlCursor: controlSequence, authorityRefs: [authority] } } }));
    } else if (request.method === "subscription.stop") for (const subscription of subscriptions) if (subscription.socket === socket && subscription.id === request.id) subscriptions.delete(subscription);
  }
}));
function emit(change) {
  const data = { kind: "control", eventId: id(100 + ++controlSequence), feedId: id(8), cursor: controlSequence,
    provenance: { originControlNodeId: authority.controlNodeId, authority }, change };
  for (const subscription of subscriptions) subscription.socket.send(JSON.stringify({ id: subscription.id, result: { type: "data", data } }));
}
await page.route("**/auth/check", route => route.fulfill({ status: 204, body: "" }));
await page.route("**/auth/session", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ method: "tailscale", storageScope: "a".repeat(43) }) }));
await page.route("**/api/mobile/**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname === "/api/mobile/activity" ? { sessions: [] } : { devices: [], watchedSessionIds: [], delivery: { pending: 0 } }) }));
await page.route("**/trpc/**", async route => {
  const request = route.request();
  const url = new URL(request.url());
  const paths = decodeURIComponent(url.pathname.slice("/trpc/".length)).split(",");
  const inputs = JSON.parse(request.method() === "POST" ? request.postData() ?? "{}" : url.searchParams.get("input") ?? "{}");
  const results = [];
  for (const [index, path] of paths.entries()) {
    const input = inputs[index];
    procedures.push(path);
    if (request.method() === "POST") mutations.push(path);
    let data;
    switch (path) {
      case "system.describe": data = { componentKind: "access-gateway", protocolVersion: 5 }; break;
      case "sources.list": data = [{ ...source, state: online ? "selected" : "unavailable", manifest: online ? source.manifest : null }]; break;
      case "controlNodes.list": data = online ? [{ controlNodeId: authority.controlNodeId }] : []; break;
      case "runtimeNodes.list": data = online ? [runtime] : []; break;
      case "sessions.search": data = { sessions: online ? [session] : [], nextCursor: null }; break;
      case "sessions.get": assert.equal(input, session.sessionId); data = session; break;
      case "harness.models": data = [model]; break;
      case "interactions.list": data = pendingInteractions; break;
      case "metadata.get": data = session.metadata; break;
      case "sessions.readNativeHistory": data = { harness: "copilot", vendorSessionId: session.vendorSessionId, complete: true, payload: { encoding: "native-json-images-v1", images: [], json: [{ id: "fixture-event", type: "assistant.message", timestamp, data: { messageId: "fixture-reply", content: "The permission controls belong to this disposable Copilot session." } }] } }; break;
      case "commands.get": data = receipts.get(input) ?? null; break;
      case "sessions.execute": {
        assert.equal(input.sessionId, session.sessionId);
        assert.equal(input.runtimeNodeId, runtime.runtimeNodeId);
        assert.equal(input.request.harness, "copilot");
        assert.equal(input.request.command.type, "setPermissionMode", "A permission control sent a prompt or unrelated command");
        assert(["manual", "allow-all"].includes(input.request.command.mode));
        assert(input.images === undefined || input.images.length === 0, "A permission command included image attachments");
        commands.push(input);
        const next = behavior; behavior = "succeeded";
        if (next === "drop") return route.abort("failed");
        if (next === "delay") await new Promise(resolve => { releaseAcknowledgment = resolve; });
        data = { commandId: input.commandId, payloadHash: input.payloadHash, sessionId: input.sessionId, runtimeNodeId: input.runtimeNodeId, request: input.request, state: next === "refused" ? "failed" : "succeeded", createdAt: timestamp, updatedAt: timestamp,
          ...(next === "refused" ? { error: "Copilot refused to enable automatic permissions" } : { result: { encoding: "native-json-images-v1", images: [], json: { mode: input.request.command.mode } } }) };
        if (data.state === "succeeded") {
          session.harnessSettings.copilotPermissions = { mode: input.request.command.mode };
          if (input.request.command.mode === "allow-all" && pendingInteractions.includes(permission)) {
            pendingInteractions = pendingInteractions.filter(item => item !== permission);
            emit({ type: "interaction.changed", interaction: { ...permission, state: "resolved" } });
          }
        }
        receipts.set(input.commandId, data);
        break;
      }
      default: throw new Error(`Unexpected fixture procedure: ${path}`);
    }
    results.push({ result: { data } });
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(results) });
});
async function eventually(check, message) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert(Date.now() < deadline, message); await page.waitForTimeout(25); }
}
async function applied(enabled) {
  await eventually(() => page.getByTestId("composer-yolo-button").innerText().then(text => text === `YOLO ${enabled ? "on" : "off"}`), "Composer did not reflect acknowledged Copilot permissions");
  await eventually(() => page.getByTestId("prompt-input").isEnabled(), "Composer stayed busy after permission acknowledgment");
}
async function slash(text) {
  await page.getByTestId("prompt-input").fill(text);
  await eventually(() => page.getByTestId("send-button").isEnabled(), "Slash control did not become ready");
  await page.getByTestId("send-button").click();
}
async function refresh() { await page.evaluate(() => window.dispatchEvent(new Event("online"))); }
async function screenshot(name) {
  const file = `${name}.png`; await page.screenshot({ path: join(output, file), fullPage: true }); screenshots.push(file);
}
async function axe(name) {
  const result = await new AxeBuilder({ page }).analyze();
  const severe = result.violations.filter(item => item.impact === "serious" || item.impact === "critical");
  assert.equal(severe.length, 0, `${name}: ${JSON.stringify(severe.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) })))}`);
  checks.push({ name, seriousOrCriticalViolations: severe.length });
}
async function closeSettings() {
  await page.keyboard.press("Escape");
  await page.getByTestId("agent-settings-popover").waitFor({ state: "detached" });
}
try {
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByText("The permission controls belong to this disposable Copilot session.", { exact: true }).waitFor();
  await applied(false);
  await page.getByTestId("interaction-attention-strip").filter({ hasText: "2 requests" }).waitFor();
  await page.getByTestId("interaction-attention-strip").click();
  assert.equal(await page.getByTestId("interaction-card").count(), 2);
  await page.getByTestId("interaction-answer").selectOption("Details");
  await page.keyboard.press("Escape");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=", "base64");
  await page.getByTestId("image-file-input").setInputFiles({ name: "permission-draft.png", mimeType: "image/png", buffer: imageBytes });
  const imageDraft = page.getByRole("button", { name: "Remove permission-draft.png" });
  await imageDraft.waitFor();
  await page.getByTestId("prompt-input").fill("Keep this text and image while I choose permissions.");
  await page.getByTestId("composer-yolo-button").click();
  await page.getByRole("tab", { name: "Permissions", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Permissions", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByTestId("permissions-option-off").getAttribute("aria-pressed"), "true");
  behavior = "delay";
  await page.getByTestId("permissions-option-on").click();
  await eventually(() => commands.length === 1 && releaseAcknowledgment, "Permissions option did not send its command");
  assert.deepEqual(commands[0].request, { harness: "copilot", command: { type: "setPermissionMode", mode: "allow-all" } });
  assert.equal(await page.getByTestId("composer-yolo-button").innerText(), "YOLO off", "Pending acknowledgment displayed YOLO as enabled");
  assert.equal(await page.getByTestId("permissions-option-off").getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByTestId("permissions-option-on").getAttribute("aria-pressed"), "false");
  releaseAcknowledgment();
  await applied(true);
  await closeSettings();
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "Keep this text and image while I choose permissions.");
  await imageDraft.waitFor();
  await page.getByTestId("interaction-attention-strip").click();
  await eventually(() => page.getByTestId("interaction-card").count().then(count => count === 1), "Resolved permission remained in pending interactions");
  assert.equal(await page.getByTestId("interaction-card").getAttribute("data-interaction-id"), question.interactionId);
  await page.getByText("Which disposable output should I review?", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  checks.push({ name: "permissions picker waits for acknowledgment, retains text/image drafts, resolves permission requests while user questions remain separate", passed: true });

  await slash("/yolo"); await applied(false);
  assert.deepEqual(commands.at(-1).request.command, { type: "setPermissionMode", mode: "manual" });
  behavior = "refused";
  await slash("/yolo on");
  await page.getByTestId("action-status").filter({ hasText: "Copilot refused" }).waitFor();
  await applied(false);
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "/yolo on");
  assert.equal(await page.getByTestId("reconcile-command").count(), 0, "Definitive refusal was treated as ambiguous");
  await imageDraft.waitFor();
  checks.push({ name: "/yolo toggles the acknowledged state and an explicit native refusal leaves YOLO off with the rejected command draft", passed: true });

  behavior = "drop";
  const beforeDrop = commands.length;
  await slash("/yolo on");
  await page.getByTestId("reconcile-command").waitFor();
  assert.equal(commands.length, beforeDrop + 1);
  assert.equal(await page.getByTestId("composer-yolo-button").innerText(), "YOLO off");
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "/yolo on");
  const saved = structuredClone(commands.at(-1));
  subscriptions.clear();
  await page.reload();
  await page.getByTestId("reconcile-command").waitFor();
  assert.equal(commands.length, beforeDrop + 1, "Reload automatically replayed ambiguous permissions");
  await imageDraft.waitFor();
  await page.getByTestId("reconcile-command").click();
  await page.getByTestId("retry-command").click();
  await applied(true);
  assert.equal(commands.length, beforeDrop + 2);
  assert.deepEqual(commands.at(-1), saved, "Permission recovery rebuilt the original command identity");
  assert.equal(await page.getByTestId("prompt-input").inputValue(), "");
  await imageDraft.waitFor();
  await slash("/yolo off"); await applied(false);
  assert.deepEqual(commands.at(-1).request.command, { type: "setPermissionMode", mode: "manual" });
  assert.equal(procedures.filter(path => /image/i.test(path)).length, 0, "Permission slash commands uploaded the unsent image");
  checks.push({ name: "ambiguous permission requests survive reload, retry only the saved envelope, and slash commands neither upload nor remove image drafts", passed: true });

  const beforeUnavailable = commands.length;
  runtime.harnesses[0].capabilities = [];
  await refresh();
  await eventually(() => page.getByTestId("composer-yolo-button").isDisabled(), "Missing capability did not disable YOLO");
  await page.getByTestId("prompt-input").fill("/");
  await page.getByTestId("slash-menu").waitFor();
  assert.equal(await page.getByTestId("slash-option-yolo").count(), 0);
  await slash("/yolo on");
  await page.getByTestId("action-status").filter({ hasText: "needs an update" }).waitFor();
  assert.equal(commands.length, beforeUnavailable);
  runtime.harnesses[0].capabilities = [capability];
  await refresh();
  await eventually(() => page.getByTestId("composer-yolo-button").isEnabled(), "Capability recovery did not enable YOLO controls");
  online = false; await refresh();
  await page.getByTestId("stale-session-notice").waitFor();
  assert.equal(await page.getByTestId("composer-yolo-button").isDisabled(), true);
  assert.equal(await page.getByTestId("send-button").isDisabled(), true);
  assert.equal(commands.length, beforeUnavailable);
  online = true; await refresh();
  await eventually(() => page.getByTestId("composer-yolo-button").isEnabled(), "Host reconnect did not restore controls");
  await page.getByTestId("prompt-input").fill("A preserved draft during responsive permission review.");
  checks.push({ name: "capability-absent and offline hosts disable permission mutation and unsupported slash input cannot dispatch", passed: true });

  for (const [width, height] of [[1720, 1180], [1440, 900], [1024, 768], [768, 1024], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await page.getByTestId("composer-yolo-button").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("permissions-option-off").waitFor();
    await page.getByRole("tab", { name: "Permissions", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.getByRole("tab", { name: "Mode", exact: true, selected: true }).waitFor();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("tab", { name: "Permissions", exact: true, selected: true }).waitFor();
    await page.getByTestId("permissions-option-on").waitFor();
    // Radix keeps the panel in the tab order so its explanatory text is
    // reachable before the first enabled choice. The current choice is disabled.
    await page.keyboard.press("Tab");
    await eventually(() => page.getByRole("tabpanel", { name: "Permissions", exact: true }).evaluate(element => element === document.activeElement), "Keyboard navigation did not reach the permissions panel");
    await page.keyboard.press("Tab");
    await eventually(() => page.getByTestId("permissions-option-on").evaluate(element => element === document.activeElement), "Keyboard navigation did not reach the YOLO choice");
    await page.waitForFunction(() => {
      const rect = document.querySelector('[data-testid="agent-settings-popover"]')?.getBoundingClientRect();
      return rect && rect.x >= -1 && rect.y >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Permissions overflow at ${width}x${height}`);
    await screenshot(`copilot-yolo-${width}x${height}`);
    await axe(`copilot-yolo-${width}x${height}`);
    await closeSettings();
    await eventually(() => page.evaluate(() => ["composer-yolo-button", "agent-settings-button"].includes(document.activeElement?.getAttribute("data-testid"))), "Closing permissions did not restore focus to a composer control");
    assert.equal(await page.getByTestId("prompt-input").inputValue(), "A preserved draft during responsive permission review.");
  }
  assert.equal(commands.length, beforeUnavailable, "Responsive keyboard review changed permissions");
  assert(mutations.every(path => path === "sessions.execute"), "Permission toggles answered a question or performed another mutation");
  assert(pendingInteractions.includes(question));
  assert.deepEqual(errors, []);
  for (const [path, hash] of Object.entries(sourceHashes)) assert.equal(sha256(await readFile(join(root, path))), hash, `Source changed during qualification: ${path}; rerun the suite`);
  const screenshotHashes = Object.fromEntries(await Promise.all(screenshots.map(async name => [name, sha256(await readFile(join(output, name)))])));
  await writeFile(join(output, "manifest.json"), JSON.stringify({ status: "passed", fixture: "intercepted Copilot permissions and durable draft fixture", realModelCalls: 0, screenshots, checks, hashes: { ...sourceHashes, ...screenshotHashes } }, null, 2) + "\n");
  console.log(`Copilot YOLO browser checks passed (${checks.length}): ${output}`);
} catch (error) {
  await screenshot("failure"); await writeFile(join(output, "failure.txt"), String(error) + "\n" + errors.join("\n")); throw error;
} finally { await context.close(); await browser.close(); await vite.close(); }
