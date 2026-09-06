#!/usr/bin/env node
// Copied beside an existing installation. Never changes its pinned host source.
import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installedDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const states = new Set(['stopped', 'waiting-for-foreground', 'starting', 'running', 'stopping']);
const busy = error => error?.errcode === 5 || error?.errcode === 6;
const foregroundBusy = error => error instanceof Error && error.message.startsWith('Stop this managed host cleanly before rerunning the installer;');

async function installedHost(directory) {
  if (process.platform !== 'win32') throw new Error('The user task requires native Windows.');
  const configPath = join(directory, 'host-install.json');
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) throw new Error('Invalid installed host configuration.');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.version !== 1 || config.platform !== 'windows' || typeof config.sourceRoot !== 'string' ||
      typeof config.environment?.LEO_STATE_DIR !== 'string' || config.environment.LEO_HARNESS !== 'copilot' ||
      config.environment.LEO_ENROLL_GATEWAYS !== '0' || config.environment.LEO_ENROLL_RUNTIMES !== '0' ||
      typeof config.installDirectory !== 'string' || resolve(config.installDirectory).toLowerCase() !== (await realpath(directory)).toLowerCase()) {
    throw new Error('The user task requires the unchanged installed Windows Copilot host.');
  }
  const privateState = await import(pathToFileURL(join(config.sourceRoot, 'dist/apps/host/src/private-state.js')).href);
  await privateState.verifyPrivateTarget(configPath);
  await privateState.verifyPrivateTarget(join(directory, 'leo-host.mjs'));
  const installer = await import(pathToFileURL(join(config.sourceRoot, 'scripts/install-copilot-host.mjs')).href);
  const launcher = await import(pathToFileURL(join(directory, 'leo-host.mjs')).href);
  return {
    ...privateState,
    async validate() {
      // Reuse the installed pin/account/path validation without starting the
      // host, changing its process environment, or requiring foreground exit.
      try {
        await lstat(join(directory, '.install-lock'));
        throw new Error('The existing host installer is active; retry after it finishes.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const environment = launcher.installedEnvironment(config);
      const roots = JSON.parse(config.environment.LEO_ALLOWED_ROOTS);
      if (roots !== '*' && (!Array.isArray(roots) || roots.length === 0 || roots.some(root => typeof root !== 'string'))) throw new Error('Invalid installed workspace policy.');
      const options = installer.parseInstallerArgs([
        'preflight', '--platform', config.platform, '--revision', config.revision,
        '--install-dir', config.installDirectory, '--name', config.environment.LEO_HOST_NAME,
        '--github-host', config.environment.LEO_COPILOT_GITHUB_HOST,
        ...(roots === '*' ? [] : roots.flatMap(root => ['--workspace', root])),
      ]);
      await installer.preflight(options, { sourceRoot: config.sourceRoot, environment, requireStopped: false });
    },
    assertHostStopped: () => installer.assertHostStopped(config.environment.LEO_STATE_DIR),
    start: () => launcher.main(['start'], directory),
  };
}

async function prepare(directory, host) {
  await host.validate();
  const service = join(directory, 'service');
  await host.privateDirectory(service);
  const target = join(service, 'runner.mjs');
  const ownBytes = await readFile(fileURLToPath(import.meta.url));
  const matches = async () => {
    await host.verifyPrivateTarget(target);
    try {
      const info = await lstat(target);
      if (info.size !== ownBytes.length || !(await readFile(target)).equals(ownBytes)) {
        throw new Error('An existing service runner differs; automatic replacement is not supported.');
      }
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (!await matches()) {
    const candidate = join(service, `runner.${randomUUID()}.tmp`);
    try {
      await host.writePrivateFile(candidate, ownBytes.toString('utf8'));
      // Publish only fully written private bytes, never replace another runner.
      try { await link(candidate, target); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!await matches()) throw new Error('The prepared service runner disappeared.');
    } finally { await unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { version: 1, prepared: true, runnerPath: target, nodePath: process.execPath };
}

async function jsonFile(path, host) {
  await host.verifyPrivateTarget(path);
  try {
    const info = await lstat(path);
    if (info.size > 16_384) throw new Error('Service state exceeds its size bound.');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function acquireLock(path, host) {
  try { const created = await open(path, 'wx', 0o600); await created.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await host.verifyPrivateTarget(path);
  let database;
  try {
    database = new DatabaseSync(path, { timeout: 0 });
    database.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM sqlite_schema;');
    return database;
  } catch (error) {
    database?.close();
    if (busy(error)) return undefined;
    throw error;
  }
}

async function locked(path, host) {
  await host.verifyPrivateTarget(path);
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    database.prepare('SELECT count(*) FROM sqlite_schema').get();
    return false;
  } catch (error) {
    if (busy(error)) return true;
    if (!(await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }))) return false;
    throw error;
  } finally { database?.close(); }
}

function discardOutput() {
  const stdout = process.stdout.write, stderr = process.stderr.write;
  const discard = (_chunk, encoding, callback) => {
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') queueMicrotask(done);
    return true;
  };
  process.stdout.write = discard;
  process.stderr.write = discard;
  return () => { process.stdout.write = stdout; process.stderr.write = stderr; };
}

/** Hooks keep lifecycle tests disposable; installed execution uses only its saved launcher. */
export async function main(args = process.argv.slice(2), directory = installedDirectory, hooks = {}) {
  const command = args[0] ?? 'help';
  if (command === 'prepare') {
    if (args.length !== 2 || !isAbsolute(args[1])) throw new Error('Use prepare with the absolute existing installation directory.');
    directory = resolve(args[1]);
  } else if (args.length > 1 || !['run', 'stop', 'status', 'help', '--help'].includes(command)) throw new Error('Use prepare INSTALLDIR, run, stop, status or help.');
  if (command === 'help' || command === '--help') return { commands: ['prepare INSTALLDIR', 'run', 'stop', 'status'], note: 'Background process status does not establish Copilot runtime readiness.' };
  const host = await (hooks.loadHost ?? installedHost)(directory);
  if (command === 'prepare') return prepare(directory, host);
  const service = join(directory, 'service');
  await host.privateDirectory(service);
  const statusPath = join(service, 'status.json'), stopPath = join(service, 'stop-request.json'), lockPath = join(service, 'runner-lock.sqlite');
  const getStatus = async () => {
    const active = await locked(lockPath, host);
    const status = await jsonFile(statusPath, host);
    if (status && (status.version !== 1 || !uuid.test(status.runId ?? '') || !states.has(status.state))) throw new Error('Invalid service status.');
    return status ? { ...status, state: active ? status.state : 'stopped', active } : { version: 1, state: active ? 'starting' : 'stopped', active };
  };
  if (command === 'status') return getStatus();
  if (command === 'stop') {
    const status = await getStatus();
    if (!status.active) return status;
    if (!status.runId) throw new Error('The background task is starting; retry stop shortly.');
    await host.writePrivateFile(stopPath, JSON.stringify({ version: 1, runId: status.runId }) + '\n');
    return { ...status, state: 'stopping', stopRequested: true };
  }
  const lock = await acquireLock(lockPath, host);
  if (!lock) return { ...(await getStatus()), alreadyRunning: true };
  const runId = randomUUID(), startedAt = new Date().toISOString();
  const history = [];
  let state, stopRequested = false, hostFinished = false, hostFailure, starting, interrupted = false, fileStopAt;
  const requestStop = () => { stopRequested = true; };
  const restoreOutput = (hooks.silenceOutput ?? discardOutput)();
  const pollMs = hooks.pollMs ?? 500;
  const stopGraceMs = hooks.stopGraceMs ?? 2_000;
  const publish = async next => {
    if (state === next) return;
    state = next;
    const updatedAt = new Date().toISOString();
    history.push({ state, at: updatedAt });
    if (history.length > 16) history.shift();
    await host.writePrivateFile(statusPath, JSON.stringify({ version: 1, runId, state, startedAt, updatedAt, lifecycle: history, ...(hostFailure ? { failure: 'HOST_FAILED' } : {}) }) + '\n');
  };
  let requestStamp, request;
  const stopping = async () => {
    const info = await lstat(stopPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    const stamp = info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` : undefined;
    // Windows ACL validation launches a system helper. Recheck changed files,
    // not the same stale fenced request every polling interval after a restart.
    if (stamp !== requestStamp) {
      request = info ? await jsonFile(stopPath, host) : undefined;
      requestStamp = stamp;
    }
    if (request?.version === 1 && request.runId === runId) fileStopAt ??= performance.now();
    // A stop may arrive through this host's own recovery command. Give that
    // command time to commit its receipt before management closes its journal.
    if (fileStopAt !== undefined && performance.now() - fileStopAt >= stopGraceMs) stopRequested = true;
    return stopRequested;
  };
  const signalHost = () => {
    // Launcher validation is asynchronous. Wait until management attached its
    // handler before emitting the one graceful in-process signal.
    if (!interrupted && (hooks.interrupt || process.listenerCount('SIGINT') > 1)) {
      interrupted = true;
      (hooks.interrupt ?? (() => process.emit('SIGINT')))();
    }
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  try {
    await publish('starting');
    while (!await stopping()) {
      if (fileStopAt !== undefined) { await delay(pollMs); continue; }
      try { await host.assertHostStopped(); break; }
      catch (error) { if (!foregroundBusy(error)) throw error; }
      await publish('waiting-for-foreground');
      await delay(pollMs);
    }
    if (stopRequested) { await publish('stopping'); return { state: 'stopped', runId }; }
    await publish('starting');
    starting = Promise.resolve().then(() => host.start()).then(
      () => { hostFinished = true; },
      () => { hostFailure = true; hostFinished = true; },
    );
    while (!hostFinished) {
      if (await stopping()) {
        await publish('stopping');
        signalHost();
      } else if (state !== 'running') {
        try { await host.assertHostStopped(); }
        catch (error) { if (!foregroundBusy(error)) throw error; await publish('running'); }
      }
      if (!hostFinished) await delay(pollMs);
    }
    await starting;
    if (hostFailure || !stopRequested || (process.exitCode ?? 0) !== 0) throw new Error('The background host failed; inspect it with the installed launcher.');
    return { state: 'stopped', runId };
  } catch {
    hostFailure = true;
    if (starting && !hostFinished) {
      while (!hostFinished) { signalHost(); await delay(pollMs); }
      await starting;
    }
    throw new Error('The background host failed; inspect it with the installed launcher.');
  } finally {
    try { await publish('stopped'); }
    finally {
      process.removeListener('SIGINT', requestStop);
      process.removeListener('SIGTERM', requestStop);
      try { lock.close(); } finally { restoreOutput(); }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => { if (process.argv[2] !== 'run') console.log(JSON.stringify(result)); }, () => {
    console.error('Windows user task failed; use service status or the installed host for diagnosis.');
    process.exitCode = 1;
  });
}
