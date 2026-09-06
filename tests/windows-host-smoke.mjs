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

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
const personalSource = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const frameworkSource = process.env.LEO_QUALIFICATION_FRAMEWORK_SHA;
assert.match(frameworkSource ?? '', /^[a-f0-9]{40}$/);
const root = await mkdtemp(join(tmpdir(), 'leo-windows-host-'));
const state = join(root, 'state');
const checks = [];
const savedLog = console.log, savedError = console.error;
try {
  await privateDirectory(state);
  await writePrivateFile(join(state, 'shared-secret'), randomBytes(48).toString('base64') + '\n');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const config = hostConfig({ ...process.env, LEO_HARNESS: 'copilot', LEO_HOST_NAME: 'windows-smoke',
    LEO_STATE_DIR: state, LEO_ALLOWED_ROOTS: JSON.stringify([root]), LEO_CONTROL_HTTP_PORT: String(port), LEO_CONTROL_P2P_BIND: '127.0.0.1:0',
  });
  let firstIdentity, previousBoot;
  for (const enroll of [true, false]) {
    const abort = new AbortController();
    let outcome;
    console.log = () => {}; console.error = () => {};
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
            const record = rows.length === 1 ? JSON.parse(rows[0].record_json) : undefined;
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
    }
    assert.notEqual(outcome, 'failed', 'managed host must shut down cleanly');
    const catalog = new ControlNodeCatalog({ filename: join(state, 'control', 'catalog.sqlite'), controlNodeName: config.name });
    try {
      const runtimes = catalog.listRuntimeNodes();
      assert.equal(runtimes.length, 1);
      const runtime = runtimes[0];
      assert.equal(runtime.name, 'windows-smoke');
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
const receipt = { result: 'passed', personalSource, frameworkSource,
  personalLockSha256: createHash('sha256').update(await readFile('package-lock.json')).digest('hex'),
  node: process.version, platform: process.platform, arch: process.arch, checks, modelCalls: 0,
  scope: 'source-candidate Windows composition only; public dependency pin is unchanged; corporate login/network/model UAT excluded',
};
const output = join('receipts', 'windows-host', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const encoded = JSON.stringify(receipt, null, 2) + '\n';
await writeFile(join(output, 'receipt.json'), encoded);
await writeFile(join(output, 'SHA256SUMS'), createHash('sha256').update(encoded).digest('hex') + '  receipt.json\n');
console.log(JSON.stringify(receipt));
