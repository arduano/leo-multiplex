// Standalone wrapper qualification: no dependencies, real authentication or model calls.
// The shell scripts are copied unchanged into disposable checkouts; only their
// helper/tool subprocesses are replaced. Run with node --test on Linux or Windows.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const revision = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
const npmVersion = '11.17.0';
const isWindows = process.platform === 'win32';
const bash = isWindows ? null : spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

const helperStub = `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.WRAPPER_TEST_LOG, JSON.stringify({ tool: 'helper', args, cwd: process.cwd() }) + '\\n');
if (!['preflight', 'configure'].includes(args[0])) process.exit(91);
if (process.env.WRAPPER_TEST_FAIL === args[0]) {
  console.error(process.env.WRAPPER_TEST_FAILURE_TEXT || 'Disposable helper failure');
  process.exit(37);
}
`;

const npmStub = `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.WRAPPER_TEST_LOG, JSON.stringify({ tool: 'npm', args, cwd: process.cwd() }) + '\\n');
const inner = args[0] === 'exec' ? args.slice(args.indexOf('--') + 2) : args;
const phase = args[0] === '--version' ? 'npm-version' : inner[0] === 'ci' ? 'ci' : args.join(' ') === 'run build' ? 'build' : 'unexpected';
if (phase === 'unexpected') process.exit(92);
if (process.env.WRAPPER_TEST_FAIL === phase) process.exit(37);
if (phase === 'npm-version') console.log(process.env.WRAPPER_TEST_NPM_VERSION || '${npmVersion}');
`;

async function fixture(t, platform, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'leo installer wrappers '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "reviewed checkout's files");
  const bin = join(directory, 'stub tools');
  await mkdir(join(checkout, 'deploy', platform), { recursive: true });
  await mkdir(join(checkout, 'scripts'));
  await mkdir(bin);
  const wrapper = join(checkout, 'deploy', platform, platform === 'windows' ? 'install.ps1' : 'install.sh');
  await copyFile(join(sourceRoot, 'deploy', platform, platform === 'windows' ? 'install.ps1' : 'install.sh'), wrapper);
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ packageManager: `npm@${npmVersion}` }));
  await writeFile(join(checkout, 'scripts', 'install-copilot-host.mjs'), helperStub);
  const npmDriver = join(directory, 'npm stub.mjs');
  await writeFile(npmDriver, npmStub);
  const log = join(directory, 'calls.jsonl');
  const environment = { ...process.env };
  // Windows environment names are case-insensitive; avoid competing Path/PATH.
  for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
  environment.PATH = options.missingTool ? bin : `${bin}${isWindows ? ';' : ':'}${process.env.PATH ?? process.env.Path ?? ''}`;
  Object.assign(environment, {
    WRAPPER_TEST_NODE: process.execPath,
    WRAPPER_TEST_NPM_DRIVER: npmDriver,
    WRAPPER_TEST_LOG: log,
    WRAPPER_TEST_FAIL: options.fail ?? '',
    WRAPPER_TEST_NPM_VERSION: options.npmVersion ?? npmVersion,
    WRAPPER_TEST_FAILURE_TEXT: options.failureText ?? '',
  });
  if (platform === 'wsl') {
    for (const tool of ['node', 'npm', 'git']) {
      if (options.missingTool === tool) continue;
      const body = tool === 'node' ? 'exec "$WRAPPER_TEST_NODE" "$@"'
        : tool === 'npm' ? 'exec "$WRAPPER_TEST_NODE" "$WRAPPER_TEST_NPM_DRIVER" "$@"'
          : 'exit 93'; // The wrapper only discovers Git; invoking it would be unexpected.
      await writeFile(join(bin, tool), `#!${bash}\n${body}\n`, { mode: 0o755 });
    }
    // A minimal PATH exercises missing prerequisites without finding real tools.
    if (options.missingTool) {
      for (const tool of ['dirname', 'cat']) {
        const executable = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
        await symlink(executable, join(bin, tool));
      }
    }
  } else {
    await writeFile(join(bin, 'npm.cmd'), '@echo off\r\n"%WRAPPER_TEST_NODE%" "%WRAPPER_TEST_NPM_DRIVER%" %*\r\nexit /b %ERRORLEVEL%\r\n');
  }
  return {
    directory, checkout, wrapper, environment,
    async calls() {
      return (await readFile(log, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    run(args, executable = bash) {
      return spawnSync(executable, args, { cwd: directory, env: environment, encoding: 'utf8', timeout: 30_000 });
    },
  };
}

const stages = calls => calls.map(call => call.tool === 'helper' ? call.args[0]
  : call.args[0] === '--version' ? 'npm-version' : call.args[0] === 'exec' ? 'ci' : call.args[0] === 'run' ? 'build' : call.args[0]);
const successfulStages = ['preflight', 'ci', 'build', 'configure'];
const assertSuccess = result => assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);

function assertInstallCalls(calls, f, expectedOptions) {
  assert.deepEqual(stages(calls), successfulStages);
  assert.deepEqual(calls.filter(call => call.tool === 'helper').map(call => call.args), [
    ['preflight', ...expectedOptions], ['configure', ...expectedOptions],
  ]);
  assert.deepEqual(calls.find(call => call.tool === 'npm' && call.args[0] === 'exec').args,
    ['exec', '--yes', '--ignore-scripts', `--package=npm@${npmVersion}`, '--', isWindows ? 'npm.cmd' : 'npm',
      'ci', '--ignore-scripts=false', '--strict-allow-scripts', '--include=dev', '--include=optional']);
  assert.deepEqual(calls.find(call => call.tool === 'npm' && call.args[0] === 'run').args, ['run', 'build']);
  // Compare filesystem identity: Windows accepts both 8.3 and long path names,
  // and Node's JavaScript realpath implementation need not expand the former.
  const expected = statSync(f.checkout, { bigint: true });
  for (const call of calls) {
    const actual = statSync(call.cwd, { bigint: true });
    assert.deepEqual([actual.dev, actual.ino], [expected.dev, expected.ino]);
  }
}

test('WSL installer preserves literal arguments, installs in order, and never logs in or starts a host', { skip: isWindows }, async t => {
  const f = await fixture(t, 'wsl');
  const options = ['--revision', revision, '--workspace', "/home/user/team's work & plans",
    '--workspace', '/home/user/$(touch should-not-exist); literal', '--secret-file', '/private/fleet secret',
    '--install-dir', '/home/user/private install', '--name', 'Work $USER; `literal`', '--github-host', 'github.example.test'];
  assertSuccess(f.run([f.wrapper, ...options]));
  assertInstallCalls(await f.calls(), f, ['--platform', 'wsl', ...options]);
});

test('WSL check performs preflight without invoking npm or configuring', { skip: isWindows }, async t => {
  const f = await fixture(t, 'wsl');
  const result = f.run([f.wrapper, '--revision', revision, '--workspace', '/home/user/work', '--check']);
  assertSuccess(result);
  assert.match(result.stdout, /No installation, login or host startup performed/);
  assert.deepEqual(stages(await f.calls()), ['preflight']);
});

for (const phase of successfulStages) {
  test(`WSL stops at failed ${phase} and propagates the subprocess failure`, { skip: isWindows }, async t => {
    const f = await fixture(t, 'wsl', { fail: phase });
    const result = f.run([f.wrapper, '--revision', revision, '--workspace', '/home/user/work']);
    assert.equal(result.status, 37, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(stages(await f.calls()), successfulStages.slice(0, successfulStages.indexOf(phase) + 1));
  });
}

test('WSL uses cached pinned npm without rejecting a different global npm', { skip: isWindows }, async t => {
  const f = await fixture(t, 'wsl', { npmVersion: '10.0.0' });
  const result = f.run([f.wrapper, '--revision', revision, '--workspace', '/home/user/work']);
  assertSuccess(result);
  assertInstallCalls(await f.calls(), f, ['--platform', 'wsl', '--revision', revision, '--workspace', '/home/user/work']);
});

for (const tool of ['node', 'npm', 'git']) {
  test(`WSL rejects missing ${tool} before any helper or package operation`, { skip: isWindows }, async t => {
    const f = await fixture(t, 'wsl', { missingTool: tool });
    const result = f.run([f.wrapper, '--revision', revision, '--workspace', '/home/user/work']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`company-approved Linux ${tool}`));
    assert.deepEqual(await f.calls(), []);
  });
}

for (const args of [['--unknown'], ['--workspace'], ['--workspace', '']]) {
  test(`WSL rejects invalid options ${JSON.stringify(args)} before execution`, { skip: isWindows }, async t => {
    const f = await fixture(t, 'wsl');
    assert.equal(f.run([f.wrapper, ...args]).status, 2);
    assert.deepEqual(await f.calls(), []);
  });
}

async function windowsRun(f, shell, overrides = {}) {
  const parameters = {
    Revision: revision,
    Workspace: ["C:\\Work & client's sandbox", 'D:\\second root'],
    SecretFile: 'C:\\Private\\fleet secret', InstallDir: 'C:\\Private\\install directory',
    Name: "Work & client's $literal; name", GitHubHost: 'github.example.test',
    ...overrides,
  };
  const paramsFile = join(f.directory, 'parameters.json');
  const driver = join(f.directory, 'driver.ps1');
  await writeFile(paramsFile, JSON.stringify(parameters));
  await writeFile(driver, `
$ErrorActionPreference = 'Stop'
$data = Get-Content -LiteralPath $env:WRAPPER_TEST_PARAMS -Raw | ConvertFrom-Json
$parameters = @{}
foreach ($property in $data.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
$tokens = $null
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($env:WRAPPER_TEST_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'The installer failed native PowerShell parsing.' }
& $env:WRAPPER_TEST_SCRIPT @parameters
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`);
  f.environment.WRAPPER_TEST_PARAMS = paramsFile;
  f.environment.WRAPPER_TEST_SCRIPT = f.wrapper;
  return { result: f.run(['-NoProfile', '-NonInteractive', '-File', driver], shell), parameters };
}

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell} rejects an explicit legacy 0.2.0 graph before dependency installation or state writes`, { skip: !isWindows }, async t => {
    const f = await fixture(t, 'windows');
    // Keep legacy coverage independent of the version currently published.
    // The actual helper reads this clean disposable checkout, never a stub.
    const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(sourceRoot, 'package-lock.json'), 'utf8'));
    for (const name of Object.keys(pkg.dependencies).filter(name => name.startsWith('@arduano/agent-multiplex-'))) {
      const url = `https://github.com/arduano/agent-multiplex/releases/download/v0.2.0/${name.slice(1).replace('/', '-')}-0.2.0.tgz`;
      pkg.dependencies[name] = pkg.overrides[name] = lock.packages[''].dependencies[name] = url;
      Object.assign(lock.packages[`node_modules/${name}`], { version: '0.2.0', resolved: url });
    }
    await writeFile(join(f.checkout, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(f.checkout, 'package-lock.json'), JSON.stringify(lock));
    await copyFile(join(sourceRoot, 'scripts/install-copilot-host.mjs'), join(f.checkout, 'scripts/install-copilot-host.mjs'));
    for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Installer Test', '-c', 'user.email=installer@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Explicit legacy release fixture']]) {
      assertSuccess(spawnSync('git', args, { cwd: f.checkout, encoding: 'utf8' }));
    }
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.checkout, encoding: 'utf8' });
    assertSuccess(commit);
    const installDirectory = join(f.directory, 'never-created-state');
    const { result } = await windowsRun(f, shell, {
      Revision: commit.stdout.trim(), Workspace: [f.directory], InstallDir: installDirectory,
      SecretFile: join(f.directory, 'never-read-secret'), GitHubHost: 'github.com', Check: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Windows installation is blocked: published framework 0\.2\.0/);
    assert.deepEqual(await f.calls(), []);
    await assert.rejects(stat(installDirectory), { code: 'ENOENT' });
  });

  test(`${shell} accepts the current Windows release preflight without installing or writing state`, { skip: !isWindows }, async t => {
    const lock = JSON.parse(await readFile(join(sourceRoot, 'package-lock.json'), 'utf8'));
    if (lock.packages['node_modules/@arduano/agent-multiplex-storage-sqlite'].version === '0.2.0') {
      t.skip('The consumer still pins legacy 0.2.0; enable the public Windows pin to qualify preflight.');
      return;
    }
    const f = await fixture(t, 'windows');
    f.wrapper = join(sourceRoot, 'deploy/windows/install.ps1');
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' });
    assertSuccess(commit);
    const directory = await realpath(f.directory);
    const installDirectory = join(directory, 'never-created-state');
    const secretFile = join(directory, 'disposable-enrollment');
    await writeFile(secretFile, 'disposable-installer-wrapper-credential-'.repeat(3));
    const { result } = await windowsRun(f, shell, {
      Revision: commit.stdout.trim(), Workspace: [directory], InstallDir: installDirectory,
      SecretFile: secretFile, GitHubHost: 'github.com', Check: true,
    });
    assertSuccess(result);
    assert.match(result.stdout, /No installation, login or host startup performed/);
    assert.deepEqual(stages(await f.calls()), []);
    await assert.rejects(stat(installDirectory), { code: 'ENOENT' });
  });

  test(`${shell} preserves literal workspace arguments and only performs installation steps`, { skip: !isWindows }, async t => {
    const f = await fixture(t, 'windows');
    const { result, parameters: p } = await windowsRun(f, shell);
    assertSuccess(result);
    const expected = ['--platform', 'windows', '--revision', revision.toLowerCase(), '--name', p.Name, '--github-host', p.GitHubHost,
      ...p.Workspace.flatMap(root => ['--workspace', root]), '--secret-file', p.SecretFile, '--install-dir', p.InstallDir];
    assertInstallCalls(await f.calls(), f, expected);
  });

  test(`${shell} Check validates without installation, login or startup`, { skip: !isWindows }, async t => {
    const f = await fixture(t, 'windows');
    const { result } = await windowsRun(f, shell, { Check: true });
    assertSuccess(result);
    assert.match(result.stdout, /No installation, login or host startup performed/);
    assert.deepEqual(stages(await f.calls()), ['preflight']);
  });

  for (const phase of successfulStages) {
    test(`${shell} stops at failed ${phase} with a failing exit code`, { skip: !isWindows }, async t => {
      const f = await fixture(t, 'windows', { fail: phase });
      const { result } = await windowsRun(f, shell);
      assert.notEqual(result.status, 0);
      assert.notEqual(result.status, null, `${result.error ?? ''}`);
      assert.deepEqual(stages(await f.calls()), successfulStages.slice(0, successfulStages.indexOf(phase) + 1));
    });
  }

  test(`${shell} preserves the failed preflight release gate before npm installation`, { skip: !isWindows }, async t => {
    const f = await fixture(t, 'windows', { fail: 'preflight', failureText: 'Published framework 0.2.0 lacks Windows ACL/storage support.' });
    const { result } = await windowsRun(f, shell, { Check: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /0\.2\.0 lacks Windows ACL\/storage support/);
    assert.deepEqual(stages(await f.calls()), ['preflight']);
  });

  test(`${shell} uses cached pinned npm without rejecting a different global npm`, { skip: !isWindows }, async t => {
    const f = await fixture(t, 'windows', { npmVersion: '10.0.0' });
    const { result } = await windowsRun(f, shell);
    assertSuccess(result);
    assert.deepEqual(stages(await f.calls()), successfulStages);
  });

  test(`${shell} rejects an invalid revision during parameter binding`, { skip: !isWindows }, async t => {
    const f = await fixture(t, 'windows');
    const { result } = await windowsRun(f, shell, { Revision: 'main' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(await f.calls(), []);
  });
}
