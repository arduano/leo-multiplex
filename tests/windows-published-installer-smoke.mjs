// Full installer qualification on disposable Windows state; never login/start.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPublishedWindowsQualification } from '../scripts/qualify-published-windows.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This installation smoke uses a disposable Windows CI runner');
const source = process.cwd();
const personalSource = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '', 'Installer qualification requires clean source');
const root = await mkdtemp('D:\\leo-published-installer-');
const installation = join(root, 'private installation');
const secretFile = join(root, 'disposable-enrollment');
const privateValue = randomBytes(48).toString('base64url');
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LEO_|AGENT_MULTIPLEX_|CODEX_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|COPILOT_)/i.test(key) && !/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|NODE_OPTIONS)$/i.test(key)));
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const wrapper = resolve('deploy/windows/install.ps1');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [];
let frameworkRelease;
let globalNpm;

function run(executable, args, label) {
  const result = spawnSync(executable, args, { cwd: source, env: environment, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  // No provider credentials enter this subprocess; its only random fixture
  // secret still must not appear in logs or assertion diagnostics.
  assert.ok(!`${result.stdout ?? ''}${result.stderr ?? ''}`.includes(privateValue), `${label} exposed the disposable enrollment credential`);
  if (result.status !== 0) {
    console.error(`${label} failed (exit ${result.status ?? 'unavailable'}).`);
    console.error(`${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll(privateValue, '<redacted>').slice(-16_000));
  }
  assert.equal(result.status, 0, `${label} must succeed`);
  return result.stdout;
}

const installArgs = ['-NoProfile', '-NonInteractive', '-File', wrapper, '-Revision', personalSource, '-InstallDir', installation, '-Name', 'windows-install-smoke'];
try {
  globalNpm = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'npm.cmd --version'], 'Global npm before installation').trim();
  await writeFile(secretFile, privateValue + '\n');
  run(powershell, [...installArgs, '-SecretFile', secretFile, '-Check'], 'Initial installer preflight');
  await assert.rejects(stat(installation), { code: 'ENOENT' });
  checks.push('initial real Windows installer preflight preserves absent installation state');

  // This is the actual npm ci/build/configure path; the workflow does not stage
  // a framework build or stub either npm or the installer helper.
  run(powershell, [...installArgs, '-SecretFile', secretFile], 'Full Windows installation');
  frameworkRelease = await readPublishedWindowsQualification(source, process.env.LEO_QUALIFICATION_RELEASE_MANIFEST, process.env.LEO_QUALIFICATION_FRAMEWORK_SHA);
  const launcher = join(installation, 'leo-host.mjs');
  const configFile = join(installation, 'host-install.json');
  const state = join(installation, 'state');
  const { verifyPrivateTarget } = await import(pathToFileURL(join(source, 'dist/apps/host/src/private-state.js')).href);
  for (const path of [configFile, launcher, join(state, 'shared-secret'), join(state, 'work-commands.json')]) await verifyPrivateTarget(path);
  const configBytes = await readFile(configFile);
  const config = JSON.parse(configBytes);
  assert.equal(config.platform, 'windows');
  assert.equal(config.revision, personalSource);
  assert.equal(config.frameworkVersion, frameworkRelease.version);
  assert.equal(config.environment.LEO_ALLOWED_ROOTS, '"*"');
  assert.equal(config.environment.LEO_HARNESS, 'copilot');
  assert.equal(config.environment.LEO_ENROLL_GATEWAYS, '0');
  assert.equal(config.environment.LEO_ENROLL_RUNTIMES, '0');
  assert.deepEqual(JSON.parse(await readFile(join(state, 'work-commands.json'), 'utf8')), { version: 1, platform: 'windows' });
  assert.equal((await readFile(join(state, 'shared-secret'), 'utf8')).trim(), privateValue);
  assert.deepEqual((await readdir(state)).sort(), ['shared-secret', 'work-commands.json']);
  checks.push('actual installer downloads locked public artifacts, builds and writes protected Copilot/work-command installation on D:');

  await rm(secretFile);
  const help = run(process.execPath, [launcher, 'help'], 'Saved launcher help');
  assert.match(help, /leo-host/);
  run(powershell, [...installArgs, '-Check'], 'Saved-installation rerun preflight');
  assert.deepEqual(await readFile(configFile), configBytes);
  assert.equal((await readFile(join(state, 'shared-secret'), 'utf8')).trim(), privateValue);
  assert.deepEqual((await readdir(state)).sort(), ['shared-secret', 'work-commands.json']);
  checks.push('saved launcher help and rerun preflight preserve configuration/credential without a new secret file, login or startup');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8' }).trim(), '');
  assert.equal(run(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'npm.cmd --version'], 'Global npm after installation').trim(), globalNpm);
  checks.push('a different global npm bootstraps the cached install tool and remains unchanged');
} finally {
  await rm(root, { recursive: true, force: true });
}
await assert.rejects(stat(root), { code: 'ENOENT' });
const receipt = { result: 'passed', personalSource, frameworkRelease, globalNpm, personalLockSha256: digest(await readFile('package-lock.json')), node: process.version, platform: process.platform, arch: process.arch, checks, modelCalls: 0, nativeSessionsCreated: 0, retainedCredentials: false, disposableStateRemoved: true, scope: 'published Windows installation, saved launcher help and preflight; corporate OAuth/network/model UAT excluded' };
const directory = join('receipts', 'windows-installer', new Date().toISOString().replaceAll(':', '-'));
await mkdir(directory, { recursive: true });
const encoded = JSON.stringify(receipt, null, 2) + '\n';
await writeFile(join(directory, 'receipt.json'), encoded);
await writeFile(join(directory, 'SHA256SUMS'), `${digest(encoded)}  receipt.json\n`);
console.log(JSON.stringify(receipt));
