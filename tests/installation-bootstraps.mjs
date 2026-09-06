// Standalone, dependency-free bootstrap qualification. All Git traffic is
// rewritten to a disposable repository containing only installer stubs. No
// package installation, host state, real credentials, login or model calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repository = 'https://github.com/arduano/leo-multiplex.git';
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const bash = windows ? null : spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
const success = result => assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'leo bootstrap tests '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, 'disposable upstream');
  const source = join(directory, "source checkout's files");
  const log = join(directory, 'delegation.json');
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`, GIT_CONFIG_VALUE_0: repository,
    GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always',
    BOOTSTRAP_TEST_LOG: log, BOOTSTRAP_TEST_EXIT: '0',
    // This Linux qualification impersonates only the WSL environment detection.
    // Windows runs under both native PowerShell shells in CI.
    WSL_DISTRO_NAME: 'disposable-bootstrap-test',
  };
  await mkdir(join(remote, 'deploy', 'wsl'), { recursive: true });
  await mkdir(join(remote, 'deploy', 'windows'), { recursive: true });
  await writeFile(join(remote, 'deploy', 'wsl', 'install.sh'), `#!/usr/bin/env bash
set -eu
node --input-type=module - "$@" <<'NODE'
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.BOOTSTRAP_TEST_LOG, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.BOOTSTRAP_TEST_EXIT));
NODE
`);
  await writeFile(join(remote, 'deploy', 'windows', 'install.ps1'), `
param([string]$Revision, [string[]]$Workspace, [string]$SecretFile, [string]$InstallDir,
      [string]$Name, [string]$GitHubHost, [switch]$Check)
$output = @{ Revision=$Revision; Workspace=$Workspace; SecretFile=$SecretFile;
  InstallDir=$InstallDir; Name=$Name; GitHubHost=$GitHubHost; Check=[bool]$Check } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($env:BOOTSTRAP_TEST_LOG, $output)
exit [int]$env:BOOTSTRAP_TEST_EXIT
`);
  const git = (args, cwd = remote) => spawnSync('git', args, { cwd, env: environment, encoding: 'utf8', timeout: 30_000 });
  success(git(['init', '--quiet']));
  success(git(['add', '.']));
  success(git(['-c', 'user.name=Bootstrap Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Disposable installer stubs']));
  const revision = git(['rev-parse', 'HEAD']).stdout.trim();
  return {
    directory, remote, source, log, environment, revision, git,
    async called() { return JSON.parse(await readFile(log, 'utf8')); },
    async notCalled() { await assert.rejects(stat(log), { code: 'ENOENT' }); },
    runWsl(args = []) {
      return spawnSync(bash, [join(sourceRoot, 'deploy/bootstrap/install-wsl.sh'), '--revision', revision.toUpperCase(),
        '--source-dir', source, '--workspace', '/home/test/work', ...args], {
        cwd: directory, env: environment, encoding: 'utf8', timeout: 30_000,
      });
    },
    async runWindows(shell, overrides = {}) {
      const parameters = {
        Revision: revision.toUpperCase(), SourceDir: source,
        Workspace: ["C:\\Work & client's sandbox", 'D:\\second root'],
        SecretFile: 'C:\\Private\\fleet secret', InstallDir: 'C:\\Private\\install directory',
        Name: "Work & client's $literal; name", GitHubHost: 'github.example.test', ...overrides,
      };
      const paramsFile = join(directory, 'parameters.json');
      const driver = join(directory, 'driver.ps1');
      await writeFile(paramsFile, JSON.stringify(parameters));
      await writeFile(driver, `
$ErrorActionPreference = 'Stop'
$data = Get-Content -LiteralPath $env:BOOTSTRAP_TEST_PARAMS -Raw | ConvertFrom-Json
$parameters = @{}
foreach ($property in $data.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
$tokens = $null
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($env:BOOTSTRAP_TEST_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'The bootstrap failed native PowerShell parsing.' }
& $env:BOOTSTRAP_TEST_SCRIPT @parameters
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`);
      return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', driver], {
        cwd: directory,
        env: { ...environment, BOOTSTRAP_TEST_PARAMS: paramsFile, BOOTSTRAP_TEST_SCRIPT: join(sourceRoot, 'deploy/bootstrap/install-windows.ps1') },
        encoding: 'utf8', timeout: 30_000,
      });
    },
  };
}

test('WSL bootstrap fetches one exact pin, preserves literal arguments, and delegates check only', { skip: windows }, async t => {
  const f = await fixture(t);
  const args = ['--workspace', "/home/test/client's work", '--name', '$(touch should-not-exist); `literal`',
    '--secret-file', '/private/fleet secret', '--install-dir', '/private/host state', '--github-host', 'github.example.test', '--check'];
  success(f.runWsl(args));
  assert.deepEqual(await f.called(), ['--revision', f.revision, '--workspace', '/home/test/work', ...args]);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.source).stdout.trim(), f.revision);
  assert.equal((await readFile(join(f.source, '.git', 'leo-bootstrap-revision'), 'utf8')).trim(), f.revision);
  await assert.rejects(stat(join(f.directory, 'should-not-exist')), { code: 'ENOENT' });
});

test('WSL bootstrap reruns the same clean owned source without fetching or changing its revision', { skip: windows }, async t => {
  const f = await fixture(t);
  success(f.runWsl());
  await rm(f.remote, { recursive: true, force: true });
  success(f.runWsl(['--check']));
  assert.equal(f.git(['rev-parse', 'HEAD'], f.source).stdout.trim(), f.revision);
});

for (const drift of ['untracked', 'tracked', 'origin', 'marker', 'unowned']) {
  test(`WSL bootstrap rejects ${drift} source drift and preserves existing files`, { skip: windows }, async t => {
    const f = await fixture(t);
    success(f.runWsl());
    await rm(f.log);
    if (drift === 'untracked') await writeFile(join(f.source, 'personal-file'), 'keep me');
    if (drift === 'tracked') await writeFile(join(f.source, 'deploy', 'wsl', 'install.sh'), 'keep my edits');
    if (drift === 'origin') success(f.git(['remote', 'set-url', 'origin', 'https://example.invalid/other.git'], f.source));
    if (drift === 'marker') await writeFile(join(f.source, '.git', 'leo-bootstrap-revision'), 'a'.repeat(40));
    if (drift === 'unowned') await rm(join(f.source, '.git', 'leo-bootstrap-revision'));
    const result = f.runWsl();
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /preserved/);
    await f.notCalled();
    if (drift === 'untracked') assert.equal(await readFile(join(f.source, 'personal-file'), 'utf8'), 'keep me');
    if (drift === 'tracked') assert.equal(await readFile(join(f.source, 'deploy', 'wsl', 'install.sh'), 'utf8'), 'keep my edits');
  });
}

test('WSL bootstrap rejects symlinked source ancestors before creating source', { skip: windows }, async t => {
  const f = await fixture(t);
  const alias = join(f.directory, 'alias');
  await symlink(f.directory, alias);
  const result = spawnSync(bash, [join(sourceRoot, 'deploy/bootstrap/install-wsl.sh'), '--revision', f.revision,
    '--source-dir', join(alias, 'new source'), '--workspace', '/home/test/work'], {
    cwd: f.directory, env: f.environment, encoding: 'utf8', timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be symlinks/);
  await f.notCalled();
  await assert.rejects(stat(join(f.directory, 'new source')), { code: 'ENOENT' });
});

test('WSL bootstrap rejects invalid revision and shared source paths before source writes', { skip: windows }, async t => {
  const f = await fixture(t);
  for (const args of [['--revision', 'main'], ['--revision', f.revision, '--source-dir', '/mnt/c/bootstrap-never-create']]) {
    const result = spawnSync(bash, [join(sourceRoot, 'deploy/bootstrap/install-wsl.sh'), '--workspace', '/home/test/work', ...args], {
      cwd: f.directory, env: f.environment, encoding: 'utf8', timeout: 30_000,
    });
    assert.notEqual(result.status, 0);
  }
  await f.notCalled();
  await assert.rejects(stat(f.source), { code: 'ENOENT' });
});

test('WSL bootstrap propagates installer failure and keeps source for review', { skip: windows }, async t => {
  const f = await fixture(t);
  f.environment.BOOTSTRAP_TEST_EXIT = '37';
  assert.equal(f.runWsl().status, 37);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.source).stdout.trim(), f.revision);
});

test('WSL bootstrap rejects source inside proposed host state before writing it', { skip: windows }, async t => {
  const f = await fixture(t);
  const result = f.runWsl(['--install-dir', f.directory]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /separate from host installation\/state/);
  await f.notCalled();
  await assert.rejects(stat(f.source), { code: 'ENOENT' });
});

test('WSL bootstrap fetch failure leaves diagnostics source in place without delegating', { skip: windows }, async t => {
  const f = await fixture(t);
  await rm(f.remote, { recursive: true, force: true });
  const result = f.runWsl();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git could not prepare or verify/);
  await f.notCalled();
  assert.equal((await stat(f.source)).isDirectory(), true);
  await assert.rejects(stat(join(f.source, '.git', 'leo-bootstrap-revision')), { code: 'ENOENT' });
});

test('WSL bootstrap fails closed when Git cannot determine checkout cleanliness', { skip: windows }, async t => {
  const f = await fixture(t);
  success(f.runWsl());
  await rm(f.log);
  await writeFile(join(f.source, '.git', 'index'), 'disposable corrupt Git index');
  const result = f.runWsl();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git could not prepare or verify/);
  await f.notCalled();
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell} bootstrap fetches the exact pin and passes literal parameters with Check`, { skip: !windows }, async t => {
    const f = await fixture(t);
    success(await f.runWindows(shell, { Check: true }));
    assert.deepEqual(await f.called(), {
      Revision: f.revision, Workspace: ["C:\\Work & client's sandbox", 'D:\\second root'],
      SecretFile: 'C:\\Private\\fleet secret', InstallDir: 'C:\\Private\\install directory',
      Name: "Work & client's $literal; name", GitHubHost: 'github.example.test', Check: true,
    });
    assert.equal(f.git(['rev-parse', 'HEAD'], f.source).stdout.trim(), f.revision);
  });

  test(`${shell} bootstrap reruns its own clean source without network or revision changes`, { skip: !windows }, async t => {
    const f = await fixture(t);
    success(await f.runWindows(shell));
    await rm(f.remote, { recursive: true, force: true });
    success(await f.runWindows(shell, { Check: true }));
    assert.equal(f.git(['rev-parse', 'HEAD'], f.source).stdout.trim(), f.revision);
  });

  for (const drift of ['untracked', 'tracked', 'origin', 'marker', 'unowned']) {
    test(`${shell} bootstrap rejects ${drift} source drift without changing existing files`, { skip: !windows }, async t => {
      const f = await fixture(t);
      success(await f.runWindows(shell));
      await rm(f.log);
      if (drift === 'untracked') await writeFile(join(f.source, 'personal-file'), 'keep me');
      if (drift === 'tracked') await writeFile(join(f.source, 'deploy', 'windows', 'install.ps1'), 'keep my edits');
      if (drift === 'origin') success(f.git(['remote', 'set-url', 'origin', 'https://example.invalid/other.git'], f.source));
      if (drift === 'marker') await writeFile(join(f.source, '.git', 'leo-bootstrap-revision'), 'a'.repeat(40));
      if (drift === 'unowned') await rm(join(f.source, '.git', 'leo-bootstrap-revision'));
      const result = await f.runWindows(shell);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /preserved/);
      await f.notCalled();
      if (drift === 'untracked') assert.equal(await readFile(join(f.source, 'personal-file'), 'utf8'), 'keep me');
      if (drift === 'tracked') assert.equal(await readFile(join(f.source, 'deploy', 'windows', 'install.ps1'), 'utf8'), 'keep my edits');
    });
  }

  test(`${shell} bootstrap rejects revision/UNC source paths without creating source`, { skip: !windows }, async t => {
    const f = await fixture(t);
    for (const overrides of [{ Revision: 'main' }, { SourceDir: '\\\\localhost\\C$\\never-create-bootstrap' }]) {
      const result = await f.runWindows(shell, overrides);
      assert.notEqual(result.status, 0);
    }
    await f.notCalled();
    await assert.rejects(stat(f.source), { code: 'ENOENT' });
  });

  test(`${shell} bootstrap propagates installer failure and keeps source for review`, { skip: !windows }, async t => {
    const f = await fixture(t);
    f.environment.BOOTSTRAP_TEST_EXIT = '37';
    assert.equal((await f.runWindows(shell)).status, 37);
    assert.equal(f.git(['rev-parse', 'HEAD'], f.source).stdout.trim(), f.revision);
  });

  test(`${shell} bootstrap rejects source inside proposed host state before writing it`, { skip: !windows }, async t => {
    const f = await fixture(t);
    const result = await f.runWindows(shell, { InstallDir: f.directory });
    assert.notEqual(result.status, 0);
    // Windows PowerShell wraps Write-Error text to the console width.
    assert.match(result.stderr.replace(/\s+/g, ' '), /separate from host installation\/state/);
    await f.notCalled();
    await assert.rejects(stat(f.source), { code: 'ENOENT' });
  });

  test(`${shell} bootstrap rejects junction source ancestors before writing source`, { skip: !windows }, async t => {
    const f = await fixture(t);
    const alias = join(f.directory, 'alias');
    await symlink(f.directory, alias, 'junction');
    const result = await f.runWindows(shell, { SourceDir: join(alias, 'never-create-source') });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.replace(/\s+/g, ' '), /must not be junctions or symlinks/);
    await f.notCalled();
    await assert.rejects(stat(join(f.directory, 'never-create-source')), { code: 'ENOENT' });
  });

  test(`${shell} bootstrap fetch failure preserves partial source without delegation`, { skip: !windows }, async t => {
    const f = await fixture(t);
    await rm(f.remote, { recursive: true, force: true });
    const result = await f.runWindows(shell);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Git could not prepare or verify/);
    await f.notCalled();
    assert.equal((await stat(f.source)).isDirectory(), true);
    await assert.rejects(stat(join(f.source, '.git', 'leo-bootstrap-revision')), { code: 'ENOENT' });
  });

  test(`${shell} bootstrap fails closed when Git cannot determine checkout cleanliness`, { skip: !windows }, async t => {
    const f = await fixture(t);
    success(await f.runWindows(shell));
    await rm(f.log);
    await writeFile(join(f.source, '.git', 'index'), 'disposable corrupt Git index');
    const result = await f.runWindows(shell);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Git could not prepare or verify/);
    await f.notCalled();
  });
}
