import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlNodeCatalog } from '@arduano/agent-multiplex-control-node-core';
import { hostConfig } from '../dist/apps/host/src/config.js';
import { runManagedHost } from '../dist/apps/host/src/manage.js';
import { privateDirectory, writePrivateFile } from '../dist/apps/host/src/private-state.js';
import { UnrestrictedWorkspacePolicy } from '../dist/apps/host/src/workspace-policy.js';
import { readPublishedWindowsQualification } from '../scripts/qualify-published-windows.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
const personalSource = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const frameworkSource = process.env.LEO_QUALIFICATION_FRAMEWORK_SHA;
assert.match(frameworkSource ?? '', /^[a-f0-9]{40}$/);
const frameworkRelease = process.env.LEO_QUALIFICATION_RELEASE_MANIFEST
  ? await readPublishedWindowsQualification(process.cwd(), process.env.LEO_QUALIFICATION_RELEASE_MANIFEST, frameworkSource)
  : undefined;
// CI's explicit second drive catches accidental C:-only configurations.
const root = await mkdtemp(join(process.env.GITHUB_ACTIONS ? 'D:\\' : tmpdir(), 'leo-windows-host-'));
const state = join(root, 'state');
const checks = [];
const savedLog = console.log, savedError = console.error;
try {
  await privateDirectory(state);
  const paths = new UnrestrictedWorkspacePolicy();
  assert.equal((await paths.validate(root.replaceAll('\\', '/'))).toLowerCase(), root.toLowerCase());
  const userHome = process.env.USERPROFILE;
  assert.ok(userHome);
  assert.ok(await paths.validate(userHome));
  checks.push('unrestricted working directories across C: and D: with forward-slash input');
  await writePrivateFile(join(state, 'shared-secret'), randomBytes(48).toString('base64') + '\n');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const config = hostConfig({ ...process.env, LEO_HARNESS: 'copilot', LEO_HOST_NAME: 'windows-smoke',
    LEO_STATE_DIR: state, LEO_ALLOWED_ROOTS: JSON.stringify('*'), LEO_CONTROL_HTTP_PORT: String(port), LEO_CONTROL_P2P_BIND: '0.0.0.0:0',
  });
  let firstIdentity, previousBoot;
  for (const enroll of [true, false]) {
    const abort = new AbortController();
    let outcome;
    const observed = { enroll, runtimeStarted: false, runtimeConnected: false, runtimeRows: 0, harnessAvailable: false, databaseRead: false, errorKinds: [] };
    console.log = (line) => {
      if (typeof line === 'string' && line.startsWith('Agent Multiplex runtime node')) observed.runtimeStarted = true;
      if (typeof line === 'string' && line.startsWith('Connected to control node')) observed.runtimeConnected = true;
    };
    console.error = (line) => {
      if (typeof line !== 'string') return;
      const kind = /timed? ?out|timeout/i.test(line) ? 'timeout'
        : /unauthor|forbidden|permission/i.test(line) ? 'authorization'
        : /connect/i.test(line) ? 'connection'
        : /inventory/i.test(line) ? 'inventory'
        : /metadata/i.test(line) ? 'metadata' : 'other';
      if (!observed.errorKinds.includes(kind)) observed.errorKinds.push(kind);
      const vocabulary = new Set('connection connect lost retrying failed failure invalid missing unsupported limit exceeded dial address addresses endpoint bootstrap locator ticket parse protocol handshake authorize unauthorized permission denied refused unreachable timeout request response function undefined method stream closed aborted'.split(' '));
      const words = (line.toLowerCase().match(/\b[a-z]+\b/g) ?? []).filter(word => vocabulary.has(word)).slice(0, 20).join(' ');
      if (words && !observed.errorKinds.includes(words)) observed.errorKinds.push(words);
    };
    const running = runManagedHost({ ...config, enrollRuntimes: enroll, enrollGateways: false }, abort.signal)
      .then(() => { outcome = 'stopped'; }, () => { outcome = 'failed'; });
    try {
      let joined = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && outcome === undefined) {
        try {
          const db = new DatabaseSync(join(state, 'control', 'catalog.sqlite'), { readOnly: true });
          try {
            const rows = db.prepare('SELECT record_json FROM runtime_nodes').all();
            observed.databaseRead = true;
            observed.runtimeRows = rows.length;
            const record = rows.length === 1 ? JSON.parse(rows[0].record_json) : undefined;
            observed.harnessAvailable = record?.harnesses?.some(harness => harness.harness === 'copilot' && harness.available) ?? false;
            joined = record?.presence === 'online' && record.runtimeNodeBootId !== previousBoot
              && record.harnesses?.some(harness => harness.harness === 'copilot' && harness.available);
          }
          finally { db.close(); }
        } catch { /* Wait until this control initializes and receives its runtime. */ }
        if (joined) break;
        await delay(250);
      }
      assert.equal(joined, true, 'combined host must register its runtime with its control');
      assert.equal(outcome, undefined, 'host must remain running until stopped');
    } finally {
      abort.abort();
      let timer;
      try { await Promise.race([running, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('host shutdown exceeded its deadline')), 30_000); })]); }
      finally { clearTimeout(timer); }
      console.log = savedLog; console.error = savedError;
      savedLog(JSON.stringify({ windowsHostObservation: observed }));
    }
    assert.notEqual(outcome, 'failed', 'managed host must shut down cleanly');
    const catalog = new ControlNodeCatalog({ filename: join(state, 'control', 'catalog.sqlite'), controlNodeName: config.name });
    try {
      const runtimes = catalog.listRuntimeNodes();
      assert.equal(runtimes.length, 1);
      const runtime = runtimes[0];
      assert.equal(runtime.name, 'windows-smoke');
      assert.deepEqual(runtime.allowedRoots, []);
      if (firstIdentity) assert.equal(runtime.runtimeNodeId, firstIdentity);
      firstIdentity = runtime.runtimeNodeId;
      previousBoot = runtime.runtimeNodeBootId;
    } finally { catalog.close(); }
    checks.push(enroll ? 'combined control/runtime starts, enrolls, and stops gracefully' : 'closed-enrollment restart preserves the canonical runtime identity');
  }
} finally {
  console.log = savedLog; console.error = savedError;
  await rm(root, { recursive: true, force: true });
}
const receipt = { result: 'passed', personalSource, frameworkSource, frameworkRelease,
  personalLockSha256: createHash('sha256').update(await readFile('package-lock.json')).digest('hex'),
  node: process.version, platform: process.platform, arch: process.arch, checks, modelCalls: 0,
  scope: frameworkRelease
    ? 'published-artifact Windows composition; corporate login/network/model UAT excluded'
    : 'source-candidate Windows composition only; public dependency pin is unchanged; corporate login/network/model UAT excluded',
};
// Qualify the work-only executor against the same dependency boundary as the host.
await import('./windows-work-command-smoke.mjs');
checks.push('work command journal, output, deduplication, cancellation and process-job cleanup');
const output = join('receipts', 'windows-host', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const encoded = JSON.stringify(receipt, null, 2) + '\n';
await writeFile(join(output, 'receipt.json'), encoded);
await writeFile(join(output, 'SHA256SUMS'), createHash('sha256').update(encoded).digest('hex') + '  receipt.json\n');
console.log(JSON.stringify(receipt));
