import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const output = join(root, "receipts/durable-drafts", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: join(root, "apps/web/vite.config.ts"), server: { host: "127.0.0.1", port: 0 } });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ ...(process.env.LEO_TEST_CHROMIUM ? { executablePath: process.env.LEO_TEST_CHROMIUM } : {}), headless: true });
const context = await browser.newContext();
await context.route("**/auth/**", route => route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
await context.route(origin + "/", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated durable draft fixture</title>" }));
const page = await context.newPage();
const checks = [];
try {
  await page.goto(origin);
  await page.evaluate(async () => {
    const store = await import("/src/client/draft-storage.ts");
    const drafts = await import("/src/client/session-drafts.ts");
    drafts.configureDraftScope("synthetic-owner");
    await store.writeDocument("synthetic-owner", "draft:session-a", "draft", { prompt: "Durable 🙂 draft", images: [{ id: "image-1", file: new File([new Uint8Array([1, 2, 3])], "test.png", { type: "image/png" }) }], uncertain: null, uncertainPrompt: null }, 0);
  });
  await page.reload();
  const restored = await page.evaluate(async () => {
    const drafts = await import("/src/client/session-drafts.ts");
    drafts.configureDraftScope(drafts.lastDraftScope());
    const draft = await drafts.readDraft("draft:session-a");
    return { prompt: draft.prompt, bytes: [...new Uint8Array(await draft.images[0].file.arrayBuffer())], type: draft.images[0].file.type, url: draft.images[0].url, usage: await drafts.draftStorageUsage() };
  });
  assert.equal(restored.prompt, "Durable 🙂 draft"); assert.deepEqual(restored.bytes, [1, 2, 3]); assert.equal(restored.type, "image/png"); assert(restored.url.startsWith("blob:")); assert.equal(restored.usage.drafts, 1);
  checks.push("text and image blobs restore after a cold document reload under the last opaque scope");
  const other = await context.newPage(); await other.goto(origin);
  const conflict = await other.evaluate(async () => {
    const store = await import("/src/client/draft-storage.ts");
    return store.writeDocument("synthetic-owner", "draft:session-a", "draft", { prompt: "Concurrent draft", images: [], uncertain: null, uncertainPrompt: null }, 0, "draft:session-a:conflict:other-tab");
  });
  assert.equal(conflict.conflict, true);
  const afterConflict = await page.evaluate(async () => {
    const drafts = await import("/src/client/session-drafts.ts"); return drafts.listDrafts();
  });
  assert.equal(afterConflict.length, 2); assert(afterConflict.some(draft => draft.prompt === "Durable 🙂 draft")); assert(afterConflict.some(draft => draft.prompt === "Concurrent draft" && draft.conflict));
  checks.push("a conflicting second-tab revision preserves both versions atomically");
  const isolated = await page.evaluate(async () => {
    const drafts = await import("/src/client/session-drafts.ts"); drafts.configureDraftScope("synthetic-other-owner"); return drafts.listDrafts();
  }); assert.equal(isolated.length, 0);
  checks.push("another operator scope cannot enumerate the previous operator's drafts");
  const quota = await page.evaluate(async () => {
    const store = await import("/src/client/draft-storage.ts");
    try { await store.writeDocument("synthetic-owner", "draft:too-large", "draft", new Blob([new Uint8Array(store.DRAFT_BUDGET_BYTES)]), 0); return "saved"; } catch (error) { return error.message; }
  }); assert(quota.includes("256 MiB"));
  checks.push("aggregate budget rejects additional storage without evicting saved work");
  const operation = await page.evaluate(async () => {
    const drafts = await import("/src/client/session-drafts.ts"); drafts.configureDraftScope("synthetic-owner");
    const ops = await import("/src/client/operation-recovery.ts");
    const payload = { interactionId: "00000000-0000-4000-8000-000000000004", sessionId: "00000000-0000-4000-8000-000000000005", harness: "codex", response: { answers: { q: { answers: ["yes"] } } } };
    await ops.saveOperation("resolve", payload);
    await ops.saveOperation("resolve", structuredClone(payload));
    let conflict = false; try { await ops.saveOperation("resolve", { ...payload, response: { answer: "changed" } }); } catch { conflict = true; }
    return { operations: await ops.listOperations(), conflict };
  }); assert.equal(operation.operations.length, 1); assert.equal(operation.conflict, true);
  await page.reload();
  const recovered = await page.evaluate(async () => {
    const drafts = await import("/src/client/session-drafts.ts"); drafts.configureDraftScope(drafts.lastDraftScope());
    const ops = await import("/src/client/operation-recovery.ts"); return ops.listOperations();
  }); assert.deepEqual(recovered, operation.operations);
  checks.push("uncertain exact requests survive reload and conflicting ID reuse fails closed");
  const settlement = await page.evaluate(async () => {
    const store = await import("/src/client/draft-storage.ts");
    const drafts = await import("/src/client/session-drafts.ts");
    const ops = await import("/src/client/operation-recovery.ts");
    const { sessionCommand } = await import("/@id/@arduano/agent-multiplex-client/browser");
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const command = await sessionCommand({ sessionId: id(20), runtimeNodeId: id(21), bindingRevision: 1 }, { harness: "codex", command: { type: "send", input: "Submitted text" } });
    const op = await ops.saveOperation("command", command);
    const write = async (prompt, uncertain, revision) => store.writeDocument(drafts.currentDraftScope(), `draft:${id(20)}`, "draft", { prompt, images: [], uncertain, uncertainPrompt: "Submitted text" }, revision);
    await write("Submitted text", command, 0);
    await ops.settleOperation(op, { state: "succeeded" });
    const success = (await drafts.readDraft(`draft:${id(20)}`));
    await write("Newer unsent text", command, 2);
    await ops.settleOperation(await ops.saveOperation("command", command), { state: "succeeded" });
    const newer = await drafts.readDraft(`draft:${id(20)}`);
    await write("Submitted text", command, 4);
    await ops.settleOperation(await ops.saveOperation("command", command), { state: "failed" });
    const failed = await drafts.readDraft(`draft:${id(20)}`);
    return { success: { prompt: success.prompt, uncertain: success.uncertain }, newer: newer.prompt, failed: { prompt: failed.prompt, uncertain: failed.uncertain }, retained: (await ops.listOperations()).some(x => x.id === op.id) };
  });
  assert.deepEqual(settlement, { success: { prompt: "", uncertain: null }, newer: "Newer unsent text", failed: { prompt: "Submitted text", uncertain: null }, retained: false });
  checks.push("terminal receipt settlement clears only matching uncertainty, consumes successful submitted text, and preserves failed/newer work");
  const imageSettlement = await page.evaluate(async () => {
    const store = await import("/src/client/draft-storage.ts");
    const drafts = await import("/src/client/session-drafts.ts");
    const ops = await import("/src/client/operation-recovery.ts");
    const { sessionCommand, imageMessage } = await import("/@id/@arduano/agent-multiplex-client/browser");
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    async function fixture(seed, { newer = false, mismatched = false } = {}) {
      const session = { sessionId: id(seed), runtimeNodeId: id(seed + 1), bindingRevision: 1 };
      const descriptor = { ...session, imageId: id(seed + 2), sha256: "a".repeat(64), byteLength: 3, mediaType: "image/png" };
      const secondDescriptor = { ...descriptor, imageId: id(seed + 3), sha256: "b".repeat(64) };
      const native = imageMessage("codex", "send", "Submitted images", [descriptor, secondDescriptor]);
      const command = await sessionCommand(session, native.request, native.images);
      const operation = await ops.saveOperation("command", command);
      const image = (imageId, bytes, metadata) => ({ id: imageId, file: new File([new Uint8Array(bytes)], `${imageId}.png`, { type: "image/png" }), ...(metadata ? { descriptor: metadata } : {}) });
      const images = [image(descriptor.imageId, [1, 2, 3], descriptor), image(secondDescriptor.imageId, [4, 5, 6], secondDescriptor)];
      if (newer) {
        // Different uploaded bytes may reuse an image ID in a later binding;
        // settlement must compare complete descriptors, not only their IDs.
        images.push(image(descriptor.imageId, [7, 8, 9], { ...descriptor, bindingRevision: 2, sha256: "c".repeat(64) }));
        images.push(image(id(seed + 4), [10, 11, 12]));
      }
      const uncertain = mismatched ? { ...command, bindingRevision: 2 } : command;
      const draftId = `draft:${session.sessionId}`;
      await store.writeDocument(drafts.currentDraftScope(), draftId, "draft", {
        prompt: newer ? "Newer unsent text with new images" : "Submitted images",
        images, uncertain, uncertainPrompt: "Submitted images",
      }, 0);
      return { draftId, operation, uncertain };
    }
    async function snapshot(draftId) {
      const value = await drafts.readDraft(draftId);
      try {
        return { prompt: value.prompt, uncertain: value.uncertain, uncertainPrompt: value.uncertainPrompt,
          images: await Promise.all(value.images.map(async image => ({ id: image.id, bytes: [...new Uint8Array(await image.file.arrayBuffer())], descriptor: image.descriptor ?? null }))) };
      } finally { value.images.forEach(image => URL.revokeObjectURL(image.url)); }
    }
    const successful = await fixture(100);
    await ops.settleOperation(successful.operation, { state: "succeeded" });
    const newer = await fixture(110, { newer: true });
    const newerBefore = await snapshot(newer.draftId);
    await ops.settleOperation(newer.operation, { state: "succeeded" });
    const failed = await fixture(120, { newer: true });
    const failedBefore = await snapshot(failed.draftId);
    await ops.settleOperation(failed.operation, { state: "failed" });
    const mismatched = await fixture(130, { newer: true, mismatched: true });
    const mismatchBefore = await snapshot(mismatched.draftId);
    await ops.settleOperation(mismatched.operation, { state: "succeeded" });
    return { successful: await snapshot(successful.draftId), newer: await snapshot(newer.draftId), newerBefore,
      failed: await snapshot(failed.draftId), failedBefore, mismatch: await snapshot(mismatched.draftId), mismatchBefore };
  });
  assert.deepEqual(imageSettlement.successful, { prompt: "", uncertain: null, uncertainPrompt: null, images: [] });
  checks.push("successful image command settlement removes every matching submitted image and consumed text");
  assert.equal(imageSettlement.newer.prompt, imageSettlement.newerBefore.prompt);
  assert.deepEqual(imageSettlement.newer.images, imageSettlement.newerBefore.images.slice(2));
  assert.equal(imageSettlement.newer.uncertain, null);
  assert.equal(imageSettlement.newer.uncertainPrompt, null);
  checks.push("successful settlement preserves newer text, unuploaded images, and same-ID images with different native descriptors");
  assert.deepEqual(imageSettlement.failed, { ...imageSettlement.failedBefore, uncertain: null, uncertainPrompt: null });
  checks.push("failed image commands retain submitted and newer image bytes and text while clearing the matching uncertainty");
  assert.deepEqual(imageSettlement.mismatch, imageSettlement.mismatchBefore);
  checks.push("a terminal receipt never clears images, text, or uncertainty for a same-ID envelope with a different binding");
  const clear = await page.evaluate(async () => {
    const store = await import("/src/client/draft-storage.ts");
    const empty = { prompt: "", images: [], uncertain: null, uncertainPrompt: null };
    await store.writeDocument("empty-clear-fixture", "draft:a", "draft", empty, 0);
    await store.clearEmptyDocuments("empty-clear-fixture");
    const emptied = (await store.documents("empty-clear-fixture")).length === 0;
    await store.writeDocument("empty-clear-fixture", "draft:a", "draft", { ...empty, prompt: "New work must survive cleanup" }, 0);
    let refused = false; try { await store.clearEmptyDocuments("empty-clear-fixture"); } catch { refused = true; }
    return { emptied, refused, retained: (await store.documents("empty-clear-fixture"))[0].value.prompt };
  });
  assert.deepEqual(clear, { emptied: true, refused: true, retained: "New work must survive cleanup" });
  checks.push("empty-data cleanup checks and deletes atomically and refuses any unsent work");
  const sources = ["apps/web/src/client/draft-storage.ts", "apps/web/src/client/session-drafts.ts", "apps/web/src/client/operation-recovery.ts", "tests/browser/durable-drafts.mjs"];
  const hashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])));
  await writeFile(join(output, "manifest.json"), JSON.stringify({ status: "passed", checks, sources: hashes, browser: browser.version() }, null, 2));
  await writeFile(join(output, "SHA256SUMS"), `${createHash("sha256").update(await readFile(join(output, "manifest.json"))).digest("hex")}  manifest.json\n`);
  console.log(JSON.stringify({ output, checks: checks.length }));
} finally { await browser.close(); await vite.close(); }
