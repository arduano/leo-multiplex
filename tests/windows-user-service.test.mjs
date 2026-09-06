import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { main } from '../scripts/windows-user-service.mjs';

const busy = () => new Error('Stop this managed host cleanly before rerunning the installer; its writer lock is active or cannot be verified.');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'leo-user-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const state = { foreground: false, live: false, starts: 0, interrupts: 0, finishOnInterrupt: true, failure: false, validations: 0, writerProbes: 0 };
  const host = {
    async validate() { state.validations++; },
    async privateDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); },
    async verifyPrivateTarget(path) {
      try { const s = await lstat(path); assert.equal(s.isFile() && !s.isSymbolicLink(), true); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    async writePrivateFile(path, contents) {
      const temp = path + '.' + randomUUID();
      await writeFile(temp, contents, { mode: 0o600 }); await rename(temp, path);
    },
    async assertHostStopped() { state.writerProbes++; if (state.foreground || state.live) throw busy(); },
    async start() { state.starts++; if (state.failure) throw new Error('fixture-secret-must-not-appear'); state.live = true; await stopped; state.live = false; },
  };
  const hooks = { loadHost: async () => host, pollMs: 5, stopGraceMs: 0, silenceOutput: () => () => {}, interrupt() { state.interrupts++; if (state.finishOnInterrupt) release(); } };
  const command = arg => main([arg], directory, hooks);
  const waitFor = async predicate => {
    for (let i = 0; i < 200; i++) { const value = await predicate(); if (value) return value; await delay(5); }
    throw new Error('Fixture lifecycle deadline elapsed');
  };
  const waitState = expected => waitFor(async () => { const s = await command('status'); return s.state === expected && s; });
  return { directory, state, host, hooks, command, release, waitFor, waitState };
}

test('waits for an existing foreground host without signalling it, then starts automatically', async t => {
  const f = await fixture(t);
  f.state.foreground = true;
  const running = f.command('run');
  await f.waitState('waiting-for-foreground');
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.interrupts, 0);
  f.state.foreground = false;
  await f.waitState('running');
  assert.equal(f.state.starts, 1);
  await f.command('stop'); await running;
  assert.equal(f.state.interrupts, 1);
  assert.equal((await f.command('status')).state, 'stopped');
});

test('prepare stages its exact bytes privately, permits same-byte rerun and preserves installation files', async t => {
  const f = await fixture(t);
  const original = { 'host-install.json': '{"sentinel":"config"}', 'leo-host.mjs': '// pinned launcher\n' };
  for (const [name, contents] of Object.entries(original)) await writeFile(join(f.directory, name), contents);
  f.state.foreground = true;
  const result = await main(['prepare', f.directory], undefined, f.hooks);
  assert.equal(result.prepared, true);
  assert.equal(result.runnerPath, join(f.directory, 'service/runner.mjs'));
  assert.deepEqual(await readFile(result.runnerPath), await readFile(new URL('../scripts/windows-user-service.mjs', import.meta.url)));
  const first = await lstat(result.runnerPath);
  const rerun = await main(['prepare', f.directory], undefined, f.hooks);
  assert.deepEqual(rerun, result);
  assert.equal((await lstat(result.runnerPath)).ino, first.ino);
  assert.equal(first.mode & 0o077, 0);
  assert.equal((await lstat(join(f.directory, 'service'))).mode & 0o077, 0);
  assert.deepEqual(await readdir(join(f.directory, 'service')), ['runner.mjs']);
  for (const [name, contents] of Object.entries(original)) assert.equal(await readFile(join(f.directory, name), 'utf8'), contents);
  assert.equal(f.state.validations, 2);
  assert.equal(f.state.writerProbes, 0);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.interrupts, 0);
});

test('prepare refuses differing runner bytes without replacement', async t => {
  const f = await fixture(t);
  await f.host.privateDirectory(join(f.directory, 'service'));
  const target = join(f.directory, 'service/runner.mjs');
  await f.host.writePrivateFile(target, '// existing reviewed runner\n');
  await assert.rejects(main(['prepare', f.directory], undefined, f.hooks), /automatic replacement is not supported/);
  assert.equal(await readFile(target, 'utf8'), '// existing reviewed runner\n');
  assert.deepEqual(await readdir(join(f.directory, 'service')), ['runner.mjs']);
});

test('prepare fails validation before writing any service files', async t => {
  const f = await fixture(t);
  f.host.validate = async () => { throw new Error('Pinned source changed'); };
  await assert.rejects(main(['prepare', f.directory], undefined, f.hooks), /Pinned source changed/);
  assert.deepEqual(await readdir(f.directory), []);
});

test('prepare rejects a symlink target without touching its contents', async t => {
  const f = await fixture(t);
  await f.host.privateDirectory(join(f.directory, 'service'));
  const original = join(f.directory, 'sentinel');
  await writeFile(original, 'keep');
  await symlink(original, join(f.directory, 'service/runner.mjs'));
  await assert.rejects(main(['prepare', f.directory], undefined, f.hooks));
  assert.equal(await readFile(original, 'utf8'), 'keep');
});

test('prepare requires exactly one absolute installation directory before loading host code', async () => {
  const hooks = { loadHost: () => assert.fail('Malformed prepare cannot load a host') };
  for (const args of [['prepare'], ['prepare', 'relative'], ['prepare', '/absolute', 'extra']]) {
    await assert.rejects(main(args, undefined, hooks), /absolute existing installation directory/);
  }
});

test('file stop returns promptly and allows the default two-second receipt grace before interrupting', async t => {
  const f = await fixture(t);
  f.hooks.stopGraceMs = undefined;
  const running = f.command('run');
  await f.waitState('running');
  const requestedAt = performance.now();
  const stopped = await f.command('stop');
  assert.equal(stopped.stopRequested, true);
  assert.ok(performance.now() - requestedAt < 500);
  await delay(1_550);
  assert.equal(f.state.interrupts, 0);
  assert.equal((await f.command('status')).active, true);
  await running;
  assert.ok(performance.now() - requestedAt >= 2_000);
  assert.equal(f.state.interrupts, 1);
});

test('running runner stops reopening native writer databases after the first live writer is established', async t => {
  const f = await fixture(t);
  const running = f.command('run');
  await f.waitState('running');
  const probes = f.state.writerProbes;
  await delay(40);
  assert.equal(f.state.writerProbes, probes);
  await f.command('stop'); await running;
});

test('ignores stale stop fences and waits for graceful host completion', async t => {
  const f = await fixture(t);
  f.state.finishOnInterrupt = false;
  const running = f.command('run');
  const status = await f.waitState('running');
  await f.host.writePrivateFile(join(f.directory, 'service/stop-request.json'), JSON.stringify({ version: 1, runId: randomUUID() }));
  await delay(30);
  assert.equal(f.state.interrupts, 0);
  assert.equal((await f.command('status')).runId, status.runId);
  await f.command('stop');
  await f.waitState('stopping');
  await f.waitFor(() => f.state.interrupts === 1);
  let complete = false; void running.then(() => { complete = true; });
  await delay(20); assert.equal(complete, false);
  assert.equal((await f.command('status')).active, true);
  f.release(); await running;
  assert.equal((await f.command('status')).active, false);
});

test('stopping while waiting never starts or signals the foreground host', async t => {
  const f = await fixture(t);
  f.state.foreground = true;
  const running = f.command('run');
  await f.waitState('waiting-for-foreground');
  await f.command('stop'); await running;
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.interrupts, 0);
  assert.equal(f.state.foreground, true);
});

test('exclusive SQLite lock prevents a second runner without PID ownership guesses', async t => {
  const f = await fixture(t);
  const running = f.command('run');
  const first = await f.waitState('running');
  const second = await f.command('run');
  assert.equal(second.alreadyRunning, true);
  assert.equal(second.runId, first.runId);
  assert.equal(f.state.starts, 1);
  await f.command('stop'); await running;
});

test('an unlocked stale running record reports stopped and old stop cannot stop the next run', async t => {
  const f = await fixture(t);
  await f.host.privateDirectory(join(f.directory, 'service'));
  const old = randomUUID();
  await f.host.writePrivateFile(join(f.directory, 'service/status.json'), JSON.stringify({ version: 1, runId: old, state: 'running' }));
  await f.host.writePrivateFile(join(f.directory, 'service/stop-request.json'), JSON.stringify({ version: 1, runId: old }));
  assert.equal((await f.command('status')).state, 'stopped');
  const running = f.command('run');
  const next = await f.waitState('running');
  assert.notEqual(next.runId, old);
  assert.equal(f.state.interrupts, 0);
  await f.command('stop'); await running;
});

test('startup failure releases the runner lock and records only a fixed failure code', async t => {
  const f = await fixture(t);
  f.state.failure = true;
  await assert.rejects(f.command('run'), /background host failed/);
  const status = await f.command('status');
  assert.equal(status.state, 'stopped'); assert.equal(status.active, false);
  assert.equal(status.failure, 'HOST_FAILED');
  const bytes = await readFile(join(f.directory, 'service/status.json'), 'utf8');
  assert.equal(bytes.includes('fixture-secret'), false);
  assert.ok(status.lifecycle.length <= 16);
  assert.ok(bytes.length < 16_384);
  f.state.failure = false;
  const running = f.command('run');
  await f.waitState('running'); await f.command('stop'); await running;
});

test('unexpected clean host exit is a task failure so the scheduler may restart it', async t => {
  const f = await fixture(t);
  f.host.start = async () => undefined;
  await assert.rejects(f.command('run'), /background host failed/);
  assert.equal((await f.command('status')).failure, 'HOST_FAILED');
});

test('unsafe foreground-state failures stop before launch instead of waiting indefinitely', async t => {
  const f = await fixture(t);
  f.host.assertHostStopped = async () => { throw new Error('The host writer lock has an unsafe path'); };
  await assert.rejects(f.command('run'), /background host failed/);
  assert.equal(f.state.starts, 0);
});

test('a crashed separate runner releases its SQLite lease without PID cleanup', async t => {
  const f = await fixture(t);
  await f.host.privateDirectory(join(f.directory, 'service'));
  const filename = join(f.directory, 'service/runner-lock.sqlite');
  await writeFile(filename, '', { mode: 0o600 });
  await f.host.writePrivateFile(join(f.directory, 'service/status.json'), JSON.stringify({ version: 1, runId: randomUUID(), state: 'running' }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { timeout: 0 });
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM sqlite_schema;');
    process.on('message', () => process.exit(23));
    process.send('locked');
  `, filename], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(child, 'message');
  assert.equal((await f.command('status')).active, true);
  const exited = once(child, 'exit'); child.send('simulate-crash');
  assert.equal((await exited)[0], 23);
  assert.equal((await f.command('status')).active, false);
  const running = f.command('run');
  await f.waitState('running'); await f.command('stop'); await running;
});

test('a stop arriving during launcher validation waits for management to attach SIGINT', async t => {
  const f = await fixture(t);
  let validate;
  const validation = new Promise(resolve => { validate = resolve; });
  f.hooks.interrupt = undefined;
  f.host.start = async () => {
    f.state.starts++;
    await validation;
    const interrupted = once(process, 'SIGINT');
    f.state.live = true;
    await interrupted;
    f.state.interrupts++;
    f.state.live = false;
  };
  const running = f.command('run');
  await f.waitFor(() => f.state.starts === 1);
  await f.command('stop'); await f.waitState('stopping');
  assert.equal(f.state.interrupts, 0);
  validate(); await running;
  assert.equal(f.state.interrupts, 1);
});
