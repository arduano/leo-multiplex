import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import { webAsset } from '../../dist/apps/web/src/index.js';

// Disposable work-host HTTP fixture. No native hosts, commands or models.
const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'receipts/work-command-browser', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const scope = 'a'.repeat(43), checks = [], errors = [], submits = [], cancels = [];
let configured = true, dropNext = false, getFails = false, rejectNext = false;
const hosts = [
  { sourceId: 'work-windows', name: 'Work Windows', platform: 'windows', endpointId: 'a'.repeat(52), available: true },
  { sourceId: 'work-wsl', name: 'Work WSL', platform: 'wsl', endpointId: 'b'.repeat(52), available: true },
];
const records = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/auth/session') return json({ method: 'cloudflare', storageScope: scope });
  if (url.pathname === '/auth/check') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/api/mobile/state') return json({ devices: [], watchedSessionIds: [], delivery: { pending: 0 } });
  if (url.pathname === '/api/mobile/activity') return json({ sessions: [] });
  if (url.pathname === '/api/mobile/config') return json({ enabled: false, origin: '', storageScope: scope });
  if (url.pathname.startsWith('/api/work-commands/')) {
    const route = url.pathname.split('/').at(-1);
    if (route === 'hosts') return json(configured ? hosts : []);
    let text = ''; for await (const part of req) text += part;
    const input = JSON.parse(text);
    const host = hosts.find(host => host.sourceId === input.target.sourceId && host.endpointId === input.target.endpointId);
    if (!host) return json({ error: { code: 'HOST_NOT_CONFIGURED' } }, 400);
    if (!host.available || getFails) return json({ error: { code: 'UNAVAILABLE' } }, 503);
    if (route === 'submit') {
      if (rejectNext) { rejectNext = false; return json({ error: { code: 'INVALID_CWD' } }, 400); }
      submits.push(input);
      const record = { ...input.request, payloadHash: 'a'.repeat(64), state: 'running', stdout: '', stderr: '', truncated: false, exitCode: null, signal: null, createdAt: new Date().toISOString(), finishedAt: null };
      records.set(input.request.operationId, record);
      if (dropNext) { dropNext = false; return json({ error: { code: 'OUTCOME_UNKNOWN' } }, 502); }
      return json(record);
    }
    const record = records.get(input.operationId) ?? null;
    if (route === 'cancel') { cancels.push(input); if (record) Object.assign(record, { state: 'cancelled', finishedAt: new Date().toISOString() }); }
    return json(record);
  }
  if (url.pathname.startsWith('/trpc/')) {
    assert.equal(req.method, 'GET', 'recovery UI must not issue agent mutations');
    const paths = decodeURIComponent(url.pathname.slice(6)).split(',');
    return json(paths.map(path => ({ result: { data: path === 'system.describe' ? { componentKind: 'access-gateway', protocolVersion: 5 } : path === 'sessions.search' ? { sessions: [], nextCursor: null } : [] } })));
  }
  const asset = webAsset(url.pathname, { styleNonce: randomBytes(24).toString('base64url') });
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': asset.contentType, 'cache-control': asset.cacheControl }); res.end(asset.body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.LEO_TEST_CHROMIUM ? { executablePath: process.env.LEO_TEST_CHROMIUM } : {}), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await context.routeWebSocket('**/trpc', ws => ws.onMessage(data => { if (data === 'PING') ws.send('PONG'); }));
const page = await context.newPage(); page.setDefaultTimeout(15_000);
page.on('pageerror', error => errors.push(error.message));
const sourceFiles = [
  'apps/web/src/client/work-commands.tsx', 'apps/web/src/client/draft-storage.ts', 'apps/web/src/client/mobile-settings.tsx',
  'packages/work-commands/src/contract.ts', 'packages/work-commands/src/http-client.ts', 'package-lock.json',
  'tests/browser/work-commands.mjs',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function sources() { return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(join(root, file)))]))); }
const before = await sources();
async function openSettings() { await page.goto(origin + '/#/settings'); await page.getByTestId('mobile-settings').waitFor(); }
async function openDialog() { await page.getByRole('button', { name: /^Open work commands/ }).click(); await page.getByTestId('work-command-dialog').waitFor(); }
async function poll(work, label) {
  for (let n = 0; n < 100; n++) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
try {
  configured = false;
  await openSettings(); await page.waitForTimeout(200);
  assert.equal(await page.getByTestId('work-commands-hatch').count(), 0);
  checks.push('no recovery hatch for personal-only gateways');
  configured = true;
  await page.reload(); await openDialog();
  const dialog = page.getByTestId('work-command-dialog');
  assert.equal(await dialog.getByRole('button', { name: 'Run command', exact: true }).isDisabled(), true);
  await dialog.getByLabel('Work host', { exact: true }).selectOption('work-wsl');
  await dialog.getByLabel('Working directory', { exact: true }).fill('/home/fixture/work');
  await dialog.getByLabel('Command', { exact: true }).fill('git status --short');
  dropNext = true;
  await dialog.getByRole('button', { name: 'Run command', exact: true }).click();
  await poll(() => submits.length === 1, 'first command admitted');
  const original = structuredClone(submits[0]);
  await page.getByText(original.request.operationId, { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('Work host', { exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload(); await openDialog();
  await page.getByText(original.request.operationId, { exact: true }).waitFor();
  assert.equal(submits.length, 1);
  assert.equal(await dialog.getByLabel('Command', { exact: true }).inputValue(), original.request.command);
  checks.push('lost reply, dialog closure and reload retain immutable request and never resubmit');
  records.get(original.request.operationId).state = 'outcomeUnknown';
  await dialog.getByRole('button', { name: 'Check original command' }).click();
  await dialog.getByText(/Outcome unknown — review the host/).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'New command' }).count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Retry original ID' }).count(), 0);
  checks.push('uncertain host receipt blocks silent new commands and retry');
  page.once('dialog', dialog => dialog.accept());
  await dialog.getByRole('button', { name: 'Save for later' }).click();
  await dialog.getByText(/Recovery record kept below/).waitFor();
  assert.equal(submits.length, 1);
  await dialog.getByText('Saved command records · 1', { exact: true }).click();
  await dialog.getByRole('button', { name: `Open saved command ${original.request.operationId}` }).click();
  await dialog.getByText(/Outcome unknown — review the host/).waitFor();
  assert.equal(submits.length, 1);
  checks.push('reviewed uncertainty can leave the form with recoverable immutable local history and no replay');
  Object.assign(records.get(original.request.operationId), { state: 'completed', exitCode: 0, stdout: '<img src=x onerror=alert(1)>\n' + 'long-command-output '.repeat(5000), stderr: 'fixture stderr\n', finishedAt: new Date().toISOString() });
  await dialog.getByRole('button', { name: 'Check original command' }).click();
  await dialog.getByTestId('work-command-output').waitFor();
  assert.equal(await dialog.getByTestId('work-command-output').locator('img').count(), 0);
  for (const [width, height] of [[1720,1180],[1440,900],[1024,768],[768,1024],[390,844],[844,390]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `document overflow at ${width}`);
    const box = await dialog.boundingBox();
    assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, `dialog clipped at ${width}`);
    const axe = await new AxeBuilder({ page }).include('[data-testid="work-command-dialog"]').analyze();
    assert.equal(axe.violations.filter(v => ['serious', 'critical'].includes(v.impact)).length, 0, JSON.stringify(axe.violations));
    await page.screenshot({ path: join(output, `${width}x${height}.png`) });
  }
  checks.push('six viewports, bounded literal output, no document overflow, no serious/critical axe findings');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: /^Open work commands/ }).evaluate(node => node === document.activeElement), true);
  await openDialog();
  await dialog.getByRole('button', { name: 'New command' }).click();
  await dialog.getByLabel('Work host', { exact: true }).selectOption('work-windows');
  await dialog.getByLabel('Working directory', { exact: true }).fill('C:\\work\\fixture');
  await dialog.getByLabel('Command', { exact: true }).fill('Get-Location');
  rejectNext = true;
  await dialog.getByRole('button', { name: 'Run command', exact: true }).click();
  await dialog.getByText(/The host rejected this submission/).waitFor();
  await dialog.getByRole('button', { name: 'New command' }).click();
  await dialog.getByLabel('Command', { exact: true }).fill('Get-Location');
  await dialog.getByRole('button', { name: 'Run command', exact: true }).click();
  await poll(() => submits.length === 2, 'windows command admitted');
  assert.equal(submits[1].request.cwd, 'C:\\work\\fixture');
  await dialog.getByRole('button', { name: 'Cancel command', exact: true }).click();
  await dialog.getByText('Cancelled', { exact: true }).waitFor();
  assert.equal(cancels.length, 1); assert.deepEqual(cancels[0].target, submits[1].target);
  checks.push('keyboard focus restores; rejected input can be edited; explicit cancellation uses original Windows target');
  await dialog.getByRole('button', { name: 'New command' }).click();
  await dialog.getByLabel('Command', { exact: true }).fill('Get-Location');
  await dialog.getByRole('button', { name: 'Run command', exact: true }).click();
  await poll(() => submits.length === 3, 'third command admitted');
  const uncertain = structuredClone(submits[2]);
  records.delete(uncertain.request.operationId);
  await dialog.getByRole('button', { name: 'Check original command' }).click();
  await dialog.getByRole('button', { name: 'Retry original ID' }).waitFor();
  await dialog.getByRole('button', { name: 'Retry original ID' }).click();
  await poll(() => submits.length === 4, 'explicit retry');
  assert.deepEqual(submits[3], uncertain);
  hosts[0].endpointId = 'c'.repeat(52);
  await page.reload(); await openDialog();
  await dialog.getByText(/This host has a different identity/).waitFor();
  assert.equal(submits.length, 4);
  assert.equal(await dialog.getByRole('button', { name: 'Cancel command' }).isDisabled(), true);
  checks.push('explicit retry uses original envelope; changed identity cannot retarget saved command');
  page.once('dialog', prompt => prompt.accept());
  await dialog.getByRole('button', { name: 'Save for later' }).click();
  const savedRecords = dialog.locator('details').filter({ hasText: 'Saved command records' });
  if (!await savedRecords.evaluate(element => element.open)) await savedRecords.locator('summary').click();
  const deletions = await savedRecords.getByRole('button', { name: /^Delete saved command/ }).count();
  for (let index = 0; index < deletions; index++) {
    page.once('dialog', prompt => prompt.accept());
    await savedRecords.getByRole('button', { name: /^Delete saved command/ }).first().click();
    await poll(async () => await savedRecords.getByRole('button', { name: /^Delete saved command/ }).count() === deletions - index - 1, 'saved input deletion committed');
  }
  assert.equal(await dialog.getByText(/Saved command records ·/).count(), 0);
  assert.equal(submits.length, 4); assert.equal(cancels.length, 1);
  checks.push('saved inputs can be explicitly deleted without remote cancellation or replay');
  assert.deepEqual(errors, []);
  assert.deepEqual(await sources(), before, 'source changed during browser run');
  const screenshotHashes = Object.fromEntries(await Promise.all((await readdir(output)).filter(file => file.endsWith('.png')).map(async file => [file, hash(await readFile(join(output, file)))])));
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ status: 'passed', checks, browser: browser.version(), sourceHashes: before, screenshotHashes, limits: 'Disposable HTTP/IndexedDB/browser fixture; no physical laptop or native shell qualification.' }, null, 2));
  process.stdout.write(JSON.stringify({ checks: checks.length, receipt: output }) + '\n');
} catch (error) { await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
