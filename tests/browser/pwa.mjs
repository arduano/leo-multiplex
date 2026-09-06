import assert from 'node:assert/strict';
import { createHash, randomBytes, createECDH } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import { webAsset } from '../../dist/apps/web/src/index.js';

// Real built worker and IndexedDB, disposable HTTP API, no native/model calls.
const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'receipts/pwa', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const scope = 'a'.repeat(43);
const sessionId = '00000000-0000-4000-8000-000000000004';
const checks = [], errors = [], mutations = [];
let authenticated = true, revision = 1;
const devices = new Map();
const fixtureKey = createECDH('prime256v1'); fixtureKey.generateKeys();
const vapidPublicKey = fixtureKey.getPublicKey().toString('base64url');
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (!authenticated) { res.writeHead(401, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<title>Sign in fixture</title>Sign in fixture'); return; }
  if (url.pathname === '/auth/session') return json({ method: 'cloudflare', storageScope: scope });
  if (url.pathname === '/auth/check') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/api/mobile/state') return json({ devices: [...devices.values()], watchedSessionIds: [], delivery: { pending: 0 } });
  if (url.pathname === '/api/mobile/activity') return json({ sessions: [] });
  if (url.pathname === '/api/mobile/config') return json({ enabled: true, publicKey: vapidPublicKey, origin: '', storageScope: scope });
  if (url.pathname.startsWith('/api/mobile/devices/')) {
    const id = url.pathname.split('/')[4];
    if (req.method === 'DELETE') { devices.delete(id); return json({ ok: true }); }
    if (req.method === 'PUT') { let data = ''; for await (const part of req) data += part; const body = JSON.parse(data); devices.set(id, { id, ...body }); return json({ ok: true }); }
    return json({ ok: true });
  }
  if (url.pathname.startsWith('/trpc/')) {
    if (req.method !== 'GET') mutations.push(url.pathname);
    const paths = decodeURIComponent(url.pathname.slice(6)).split(',');
    const results = paths.map(path => ({ result: { data: path === 'system.describe' ? { componentKind: 'access-gateway', protocolVersion: 5 } : path === 'sessions.search' ? { sessions: [], nextCursor: null } : [] } }));
    return json(results);
  }
  const asset = webAsset(url.pathname, { styleNonce: randomBytes(24).toString('base64url') });
  if (!asset) { res.writeHead(404); res.end(); return; }
  let body = asset.body;
  if (url.pathname === '/sw.js' && revision > 1) body = Buffer.from(body.toString().replace(/"version":"([^"]+)"/, `"version":"$1-fixture-${revision}"`));
  res.writeHead(200, { 'content-type': asset.contentType, 'cache-control': asset.cacheControl }); res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.LEO_TEST_CHROMIUM ? { executablePath: process.env.LEO_TEST_CHROMIUM } : {}), headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', permissions: ['notifications'] });
await context.routeWebSocket('**/trpc', ws => ws.onMessage(data => { if (data === 'PING') ws.send('PONG'); }));
const page = await context.newPage(); page.setDefaultTimeout(20_000);
page.on('pageerror', error => errors.push(error.message));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function inventory(dir) { const result = {}; for (const entry of await readdir(join(root, dir), { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) Object.assign(result, await inventory(path)); else result[path] = hash(await readFile(join(root, path))); } return result; }
async function poll(work, label) {
  for (let n = 0; n < 100; n++) { try { const value = await work(); if (value) return value; } catch (error) { if (!String(error).includes('Execution context was destroyed')) throw error; } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  await page.goto(origin + '/#/agents');
  await page.getByTestId('mobile-agents-home').waitFor();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const manifest = await (await fetch(origin + '/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.start_url, '/#/agents');
  assert(manifest.icons.some(icon => icon.purpose === 'maskable'));
  checks.push('Android list home, install manifest and real service-worker control');
  await page.evaluate(async ({ scope, sessionId }) => {
    localStorage.setItem('leo.drafts.lastScope', scope);
    const request = indexedDB.open('leo-local-work', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('work', { keyPath: ['scope', 'id'] }).createIndex('scope', 'scope');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const tx = db.transaction('work', 'readwrite');
    tx.objectStore('work').put({ scope, id: `draft:${sessionId}`, kind: 'draft', revision: 1, updatedAt: Date.now(), bytes: 200, value: { prompt: 'Phone draft survives offline', images: [{ id: crypto.randomUUID(), file: new File([bytes], 'saved.png', { type: 'image/png' }) }], uncertain: null, uncertainPrompt: null } });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
  }, { scope, sessionId });
  await page.evaluate(async () => { await fetch('/auth/session'); await fetch('/api/mobile/state'); await fetch('/trpc/sessions.search'); });
  const cacheInventory = await page.evaluate(async () => { const values = []; for (const key of await caches.keys()) for (const req of await (await caches.open(key)).keys()) values.push(new URL(req.url).pathname); return values; });
  assert(cacheInventory.length > 5); assert(cacheInventory.every(path => path.startsWith('/assets/') || path.startsWith('/icons/') || path === '/offline-shell.html'));
  const template = await page.evaluate(async () => (await (await caches.match('/offline-shell.html')).text()));
  assert(!template.includes('agent-multiplex-style-nonce'));
  checks.push('only build assets and nonce-free shell cached; API/auth/transcripts absent');
  await context.setOffline(true);
  const offlineResponse = await page.reload({ waitUntil: 'domcontentloaded' });
  assert(offlineResponse.headers()['content-security-policy'].includes('nonce-'));
  await page.getByText('Phone draft survives offline', { exact: true }).click();
  const editor = page.getByTestId('saved-draft-editor'); await editor.waitFor();
  await editor.getByRole('img', { name: 'saved.png' }).waitFor();
  await editor.getByRole('textbox', { name: 'Saved message draft' }).fill('Edited safely offline');
  await editor.getByTestId('saved-camera-input').setInputFiles({ name: 'camera.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=', 'base64') });
  await editor.getByRole('img', { name: 'camera.png' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('Saved on this device')));
  await page.screenshot({ path: join(output, 'android-offline-editor.png') });
  const axe = await new AxeBuilder({ page }).analyze(); assert.equal(axe.violations.filter(v => ['serious', 'critical'].includes(v.impact)).length, 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Edited safely offline', { exact: true }).click();
  await page.getByRole('img', { name: 'camera.png' }).waitFor();
  await page.getByRole('button', { name: 'Remove camera.png' }).click();
  await page.getByRole('button', { name: 'Back to saved drafts' }).click();
  checks.push('cold offline launch restores text/image blobs; camera input and edits autosave across reload/Back');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByTestId('mobile-agents-home').waitFor();
  revision = 2;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.getByRole('button', { name: 'Save and update', exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await caches.keys()).length), 2);
  await page.getByRole('button', { name: 'Save and update', exact: true }).click();
  await poll(() => page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); return Boolean(reg.active && !reg.waiting); }), 'worker activation');
  await page.getByTestId('mobile-agents-home').waitFor();
  await page.getByTestId('mobile-settings-button').click();
  await page.getByText('Edited safely offline', { exact: true }).waitFor();
  checks.push('waiting update requires explicit activation and keeps durable drafts');
  await page.evaluate(() => {
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/disposable-fixture', expirationTime: null, keys: { p256dh: 'synthetic', auth: 'synthetic' } };
    const mocked = { toJSON: () => subscription, options: {}, unsubscribe: async () => { window.fixtureUnsubscribed = true; return true; } };
    PushManager.prototype.getSubscription = async () => window.fixtureUnsubscribed ? null : mocked;
    PushManager.prototype.subscribe = async () => mocked;
  });
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Send test notification', exact: true }).waitFor();
  assert.equal(devices.size, 1);
  await page.getByRole('checkbox', { name: 'Finished', exact: true }).click();
  await poll(() => ![...devices.values()][0].categories.completion, 'category saved');
  await page.getByRole('button', { name: 'Disable on this device', exact: true }).click();
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).waitFor();
  assert.equal(devices.size, 0); assert.equal(await page.evaluate(() => window.fixtureUnsubscribed), true);
  checks.push('explicit push registration, device category update and revoke UI with a mocked PushManager and no FCM network calls');
  // CDP dispatches a real push event through the installed built worker, with no external push service.
  const cdp = await context.newCDPSession(page);
  let registrationId;
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => { for (const reg of registrations) if (reg.scopeURL === origin + '/') registrationId = reg.registrationId; });
  await cdp.send('ServiceWorker.enable');
  await page.waitForTimeout(300);
  assert(registrationId, 'Worker registration observable');
  const payload = { version: 1, eventId: 'fixture-completed', title: 'Watched fixture', body: 'Finished', sessionId, kind: 'completion', tag: 'fixture', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId, data: JSON.stringify(payload) });
  const notifications = await poll(() => page.evaluate(async () => {
    const list = (await (await navigator.serviceWorker.getRegistration()).getNotifications()).filter(n => n.title === 'Watched fixture');
    return list.length ? list.map(n => ({ title: n.title, body: n.body, data: n.data })) : false;
  }), 'delivered notification');
  assert.equal(notifications[0].body, 'Finished'); assert.equal(notifications[0].data.sessionId, sessionId);
  await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId, data: JSON.stringify({ ...payload, title: 'Invalid fixture', expiresAt: 'invalid' }) });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration()).getNotifications()).filter(n => n.title === 'Invalid fixture').length), 0);
  checks.push('real built-worker push produces title/status notification and rejects malformed expiry');
  authenticated = false;
  const expired = await page.reload(); assert.equal(expired.status(), 401);
  await page.getByText('Sign in fixture').waitFor();
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Edited safely offline', { exact: true }).waitFor();
  assert.equal(await page.getByText('Sign in fixture').count(), 0);
  checks.push('expired login stays a network authentication response; offline fallback never caches it');
  assert.deepEqual(mutations, []); assert.deepEqual(errors, []);
  const result = { status: 'passed', browser: browser.version(), checks, modelCalls: 0, sessionMutations: 0, cacheInventory, sources: { ...await inventory('apps/web'), ...await inventory('dist/web'), 'tests/browser/pwa.mjs': hash(await readFile(import.meta.filename)) } };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(result, null, 2));
  const sums = []; for (const name of await readdir(output)) sums.push(`${hash(await readFile(join(output, name)))}  ${name}`);
  await writeFile(join(output, 'SHA256SUMS'), sums.join('\n') + '\n');
  console.log(JSON.stringify({ output, checks: checks.length }));
} catch (error) { await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), errors, checks }, null, 2)); throw error; }
finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
