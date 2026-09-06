import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertHostStopped, configureInstallation, inspectExistingInstallation, installationLayout, parseInstallerArgs, preflight, validateCheckout, validatePlatform, validateRelease, validateWslFilesystem } from '../scripts/install-copilot-host.mjs';
import { installedEnvironment, validateHostCommand } from '../scripts/installed-copilot-host.mjs';
import { privateDirectory, writePrivateFile } from '../apps/host/src/private-state.js';
import { importEnrollmentSecret } from '../apps/host/src/enrollment.js';

const source = process.cwd();
const revision = '0123456789abcdef0123456789abcdef01234567';
const directories: string[] = [];
const secret = 'installer-disposable-fleet-value-'.repeat(3);
const dependencies = { privateDirectory, writePrivateFile, importEnrollmentSecret, storage: {} };
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'leo-install-test-')); directories.push(dir); return dir; }
async function fixture() {
  const directory = await temporary();
  const sourceRoot = join(directory, 'source'), workspace = join(directory, 'work'), input = join(directory, 'fleet-file');
  await mkdir(join(sourceRoot, 'scripts'), { recursive: true });
  await mkdir(join(sourceRoot, 'bin'));
  await mkdir(join(sourceRoot, 'dist/apps/host/src'), { recursive: true });
  await mkdir(workspace);
  for (const name of ['package.json', 'package-lock.json', 'scripts/install-copilot-host.mjs', 'scripts/installed-copilot-host.mjs']) await writeFile(join(sourceRoot, name), await readFile(join(source, name)));
  await writeFile(input, secret, { mode: 0o600 });
  await writeFile(join(sourceRoot, 'dist/apps/host/src/manage.js'), `export async function main(args, environment) {
    const running = args[0] === 'start' ? new Promise(resolve => { const timer = setInterval(() => {}, 1000); process.once('SIGINT', () => {clearInterval(timer); console.log('Graceful fixture close'); resolve();}); }) : undefined;
    console.log(JSON.stringify({harness:process.env.LEO_HARNESS, proxy:environment.HTTPS_PROXY, personal:process.env.OPENAI_API_KEY, args, pid:process.pid}));
    await running;
  }\n`);
  const git = (args: string[]) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']); git(['add', '.']);
  git(['-c', 'user.name=Installer Test', '-c', 'user.email=installer@example.invalid', 'commit', '--quiet', '-m', 'Disposable fixture']);
  const actualRevision = git(['rev-parse', 'HEAD']);
  const environment = { ...process.env, HOME: directory, XDG_STATE_HOME: join(directory, 'native-state'), WSL_DISTRO_NAME: 'InstallerFixture' };
  const options = parseInstallerArgs(['configure', '--platform', 'wsl', '--revision', actualRevision, '--workspace', workspace, '--secret-file', input]);
  return { directory, sourceRoot, workspace, input, options, environment, git };
}

it('requires exact revisions, deliberate workspace roots, and valid corporate host names', () => {
  expect(() => parseInstallerArgs(['configure', '--platform', 'wsl', '--revision', 'main', '--workspace', '/work'])).toThrow('40-character');
  expect(() => parseInstallerArgs(['configure', '--platform', 'wsl', '--revision', revision])).toThrow('--workspace');
  expect(() => parseInstallerArgs(['configure', '--platform', 'wsl', '--revision', revision, '--workspace', '/work', '--github-host', 'https://github.com'])).toThrow('--github-host');
  expect(parseInstallerArgs(['preflight', '--platform', 'wsl', '--revision', revision, '--workspace', '/work', '--workspace', '/team', '--check'])).toMatchObject({ phase: 'preflight', name: 'work-wsl', githubHost: 'github.com', check: true, workspaces: ['/work', '/team'] });
});

it('separates Windows and WSL identity directories, names and ports from personal hosts', () => {
  const windows = installationLayout(parseInstallerArgs(['preflight', '--platform', 'windows', '--revision', revision, '--workspace', 'C:\\Work']), { USERPROFILE: 'C:\\Users\\Leo', LOCALAPPDATA: 'C:\\Users\\Leo\\AppData\\Local' }, 'C:\\source');
  const wsl = installationLayout(parseInstallerArgs(['preflight', '--platform', 'wsl', '--revision', revision, '--workspace', '/work']), { HOME: '/home/leo' }, '/source');
  expect(windows.environment).toMatchObject({ LEO_HARNESS: 'copilot', LEO_HOST_NAME: 'work-windows', LEO_CONTROL_HTTP_PORT: '4317', LEO_CONTROL_P2P_BIND: '0.0.0.0:49117', LEO_ENROLL_GATEWAYS: '0', LEO_ENROLL_RUNTIMES: '0' });
  expect(windows.installDirectory).toBe('C:\\Users\\Leo\\AppData\\Local\\leo-multiplex-windows');
  expect(wsl.environment).toMatchObject({ LEO_HARNESS: 'copilot', LEO_HOST_NAME: 'work-wsl', LEO_CONTROL_HTTP_PORT: '4319', LEO_CONTROL_P2P_BIND: '0.0.0.0:49119' });
  expect(wsl.installDirectory).toBe('/home/leo/.local/state/leo-multiplex-wsl');
});

it.each(['/source/state', '/home/leo/.codex/host', '/home/leo/.copilot/host', '/home/leo/.local/state/leo-multiplex/host', '/home/leo/.local/state/leo-multiplex-windows', '/mnt/c/host', '/home/leo'])('refuses unsafe or shared WSL installation location %s', installDirectory => {
  const options = parseInstallerArgs(['preflight', '--platform', 'wsl', '--revision', revision, '--workspace', '/work', '--install-dir', installDirectory]);
  expect(() => installationLayout(options, { HOME: '/home/leo' }, '/source')).toThrow();
});

it('rejects Windows shared filesystem paths and relative workspace roots', () => {
  const args = ['preflight', '--platform', 'windows', '--revision', revision, '--workspace', 'C:\\work', '--install-dir'];
  expect(() => installationLayout(parseInstallerArgs([...args, '\\\\wsl.localhost\\Ubuntu\\home\\host']), { USERPROFILE: 'C:\\Users\\Leo' }, 'C:\\source')).toThrow('local filesystem');
  const options = parseInstallerArgs(['preflight', '--platform', 'wsl', '--revision', revision, '--workspace', 'work']);
  expect(() => installationLayout(options, { HOME: '/home/leo' }, '/source')).toThrow('absolute');
});

it('requires native x64 Node24 and a real WSL Linux environment', () => {
  const system = { arch: 'x64', nodeVersion: '24.0.0', platform: 'linux', execPath: '/usr/bin/node', environment: {}, osRelease: '6.6-microsoft-standard-WSL2' };
  expect(() => validatePlatform('wsl', system)).not.toThrow();
  expect(() => validatePlatform('wsl', { ...system, osRelease: '6.6-generic' })).toThrow('inside WSL');
  expect(() => validatePlatform('wsl', { ...system, execPath: '/mnt/c/node.exe' })).toThrow('Linux Node.js');
  expect(() => validatePlatform('windows', system)).toThrow('native Windows');
  expect(() => validatePlatform('windows', { ...system, platform: 'win32', arch: 'arm64' })).toThrow('x64');
  expect(() => validatePlatform('wsl', { ...system, nodeVersion: '22.0.0' })).toThrow('24');
});

it('rejects shared WSL state filesystems outside the conventional /mnt prefix', () => {
  const mount = (directory: string, type: string) => `29 20 0:25 / ${directory} rw,relatime - ${type} shared rw`;
  expect(() => validateWslFilesystem('/home/leo/state', mount('/', 'ext4'))).not.toThrow();
  for (const type of ['9p', 'drvfs', 'cifs', 'nfs4', 'fuse.vmhgfs-fuse']) {
    expect(() => validateWslFilesystem('/home/leo/shared/state', mount('/home/leo/shared', type))).toThrow('shared mount');
    expect(() => validateWslFilesystem('/home/leo/shared-other/state', mount('/home/leo/shared', type))).not.toThrow();
  }
  expect(() => validateWslFilesystem('/home/leo/shared drive/state', mount('/home/leo/shared\\040drive', '9p'))).toThrow('shared mount');
});

it('gates Windows on the published release before private-state work, and rejects mutable dependencies', async () => {
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'));
  expect(validateRelease(pkg, lock, 'wsl')).toBe('0.2.0');
  expect(() => validateRelease(pkg, lock, 'windows')).toThrow('Windows installation is blocked');
  const modified = structuredClone(lock);
  modified.packages['node_modules/@arduano/agent-multiplex-storage-sqlite'].resolved = 'file:../candidate.tgz';
  expect(() => validateRelease(pkg, modified, 'wsl')).toThrow('public release');
  const overridden = structuredClone(pkg);
  overridden.overrides['@arduano/agent-multiplex-storage-sqlite'] = '../candidate';
  expect(() => validateRelease(overridden, lock, 'wsl')).toThrow('overrides');
  const linked = structuredClone(lock);
  linked.packages['node_modules/untrusted'] = { link: true, resolved: '../candidate' };
  expect(() => validateRelease(pkg, linked, 'wsl')).toThrow('immutable');
});

it('checks the exact clean checkout instead of accepting a moving branch or tracked edits', () => {
  const run = (args: string[]) => args.includes('--show-toplevel') ? '/source' : args.includes('HEAD') ? revision : '';
  expect(() => validateCheckout('/source', revision, run)).not.toThrow();
  expect(() => validateCheckout('/source', 'f'.repeat(40), run)).toThrow('exact revision');
  expect(() => validateCheckout('/source', revision, (args: string[]) => args[0] === 'status' ? ' M package.json' : run(args))).toThrow('tracked changes');
});

it('only dispatches explicit host management commands and defaults to help', () => {
  expect(validateHostCommand([])).toEqual(['help']);
  expect(validateHostCommand(['start'])).toEqual(['start']);
  expect(validateHostCommand(['start', '--enroll'])).toEqual(['start', '--enroll']);
  expect(validateHostCommand(['command-recovery', '11111111-1111-4111-8111-111111111111', '--processes-inspected'])).toHaveLength(3);
  expect(() => validateHostCommand(['command-recovery', '11111111-1111-4111-8111-111111111111'])).toThrow();
  expect(validateHostCommand(['login', '--device-code', '--host', 'https://company.ghe.com'])).toHaveLength(4);
  expect(() => validateHostCommand(['start', '--enroll', '--enroll'])).toThrow();
  expect(() => validateHostCommand(['-e', 'console.log(1)'])).toThrow();
  expect(() => validateHostCommand(['login', '--host', 'https://example.com'])).toThrow();
});

describe.skipIf(process.platform !== 'linux')('Linux filesystem installation', () => {
  it('preflights without mutation, installs privately, and preserves identities on exact reruns', async () => {
    const f = await fixture();
    const { config, layout } = await preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment });
    await expect(stat(layout.installDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await configureInstallation(config, f.input, dependencies);
    expect((await stat(layout.installDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(layout.configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(layout.stateDirectory, 'shared-secret'))).mode & 0o777).toBe(0o600);
    const marker = join(layout.stateDirectory, 'work-commands.json');
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ version: 1, platform: 'wsl' });
    expect((await stat(marker)).mode & 0o777).toBe(0o600);
    const stored = await readFile(layout.configFile, 'utf8');
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(f.input);
    await writeFile(join(layout.stateDirectory, 'existing-identity'), 'keep-identity');
    await configureInstallation(config, undefined, dependencies);
    expect(await readFile(layout.configFile, 'utf8')).toBe(stored);
    expect(await readFile(join(layout.stateDirectory, 'existing-identity'), 'utf8')).toBe('keep-identity');
    expect(await readdir(layout.installDirectory)).toEqual(['host-install.json', 'leo-host.mjs', 'state']);
  });

  it('rejects conflicting configuration and credentials before creating files or changing permissions', async () => {
    const f = await fixture();
    const { config, layout } = await preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment });
    await configureInstallation(config, f.input, dependencies);
    const calls: string[] = [];
    const noWrites = { ...dependencies, privateDirectory: async () => { calls.push('directory'); }, writePrivateFile: async () => { calls.push('file'); }, importEnrollmentSecret: async () => { calls.push('secret'); } };
    await expect(configureInstallation({ ...config, revision }, f.input, noWrites)).rejects.toThrow('different configuration');
    await writeFile(f.input, 'different-disposable-credential-'.repeat(3));
    await expect(configureInstallation(config, f.input, noWrites)).rejects.toThrow('another enrollment credential');
    expect(calls).toEqual([]);
    expect((await readFile(join(layout.stateDirectory, 'shared-secret'), 'utf8')).trim()).toBe(secret);
  });

  it('rejects unsafe ancestor symlinks and missing workspaces without creating state', async () => {
    const f = await fixture();
    await mkdir(join(f.directory, 'redirected'));
    await symlink(join(f.directory, 'redirected'), join(f.directory, 'alias'));
    const options = { ...f.options, installDirectory: join(f.directory, 'alias', 'host') };
    await expect(preflight(options, { sourceRoot: f.sourceRoot, environment: f.environment })).rejects.toThrow('symlinks');
    expect(await readdir(join(f.directory, 'redirected'))).toEqual([]);
    await expect(preflight({ ...f.options, workspaces: [join(f.directory, 'missing')] }, { sourceRoot: f.sourceRoot, environment: f.environment })).rejects.toThrow('workspace');
    await expect(stat(join(f.environment.XDG_STATE_HOME, 'leo-multiplex-wsl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires a fleet credential initially and reuses the existing private one later', async () => {
    const f = await fixture();
    const { config } = await preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment });
    await expect(inspectExistingInstallation(config, undefined)).rejects.toThrow('first installation');
    await configureInstallation(config, f.input, dependencies);
    await expect(inspectExistingInstallation(config, undefined)).resolves.toBe(true);
  });

  it('refuses a redirected state directory even when the installation itself is private', async () => {
    const f = await fixture();
    const { config, layout } = await preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment });
    await configureInstallation(config, f.input, dependencies);
    await rm(layout.stateDirectory, { recursive: true });
    await mkdir(join(f.directory, 'other-state'));
    await symlink(join(f.directory, 'other-state'), layout.stateDirectory);
    await expect(preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment })).rejects.toThrow('symlinks');
    expect(await readdir(join(f.directory, 'other-state'))).toEqual([]);
  });

  it('keeps corporate proxy/CA settings while stripping inherited personal auth and rejecting host conflicts', async () => {
    const f = await fixture();
    const { config } = await preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment });
    const environment = installedEnvironment(config, { HTTPS_PROXY: 'http://proxy.example.invalid:8080', NODE_EXTRA_CA_CERTS: '/corporate.pem', OPENAI_API_KEY: 'disposable', CODEX_HOME: '/personal', GH_TOKEN: 'disposable', NODE_OPTIONS: '--import=untrusted' });
    expect(environment).toMatchObject({ HTTPS_PROXY: 'http://proxy.example.invalid:8080', NODE_EXTRA_CA_CERTS: '/corporate.pem', LEO_HARNESS: 'copilot', LEO_STATE_DIR: config.environment.LEO_STATE_DIR });
    expect(environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(environment).not.toHaveProperty('CODEX_HOME');
    expect(environment).not.toHaveProperty('GH_TOKEN');
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(() => installedEnvironment(config, { LEO_HARNESS: 'codex' })).toThrow('Conflicting inherited');
    expect(() => installedEnvironment(config, { LEO_STATE_DIR: '/personal' })).toThrow('Conflicting inherited');
    expect(() => installedEnvironment(config, { LEO_ENROLL_GATEWAYS: '1' })).toThrow('Conflicting inherited');
    expect(() => installedEnvironment(config, { LEO_HARNESS: 'copilot' })).not.toThrow();
  });

  it('launches from the persisted location and refuses source drift before host dispatch', async () => {
    const f = await fixture();
    const { config } = await preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment });
    await configureInstallation(config, f.input, dependencies);
    const launcher = join(config.installDirectory, 'leo-host.mjs');
    const environment = { ...f.environment, HTTPS_PROXY: 'http://proxy.example.invalid:8080', OPENAI_API_KEY: 'disposable' };
    const run = () => execFileSync(process.execPath, [launcher, 'help'], { cwd: f.directory, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(JSON.parse(run())).toMatchObject({ harness: 'copilot', proxy: environment.HTTPS_PROXY, args: ['help'] });
    await writeFile(join(f.sourceRoot, 'dist/apps/host/src/manage.js'), 'throw new Error("must never execute");');
    expect(run).toThrow();
  });

  it('runs management in the console process so Ctrl+C reaches graceful host shutdown', async () => {
    const f = await fixture();
    const { config } = await preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment });
    await configureInstallation(config, f.input, dependencies);
    const child = spawn(process.execPath, [join(config.installDirectory, 'leo-host.mjs'), 'start'], { env: f.environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const closed = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      await new Promise<void>((resolveReady, reject) => {
        child.once('error', reject);
        child.stdout.once('data', chunk => { output += chunk; resolveReady(); });
        child.once('exit', () => reject(new Error('Fixture exited before ready')));
      });
      expect(JSON.parse(output).pid).toBe(child.pid);
      child.stdout.on('data', chunk => { output += chunk; });
      child.kill('SIGINT');
      await expect(closed).resolves.toEqual({ code: 0, signal: null });
      expect(output).toContain('Graceful fixture close');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  });

  it.each([['control', 'catalog.sqlite'], ['work-commands', 'operations.sqlite']])('refuses dependency reinstall while %s holds its writer lock, without changing that lock', async (role, filename) => {
    const f = await fixture();
    const { config, layout } = await preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment });
    await configureInstallation(config, f.input, dependencies);
    const directory = join(layout.stateDirectory, role);
    await mkdir(directory, { mode: 0o700 });
    const { DatabaseSync } = await import('node:sqlite');
    const lock = new DatabaseSync(join(directory, `${filename}.lock.sqlite`));
    lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    try {
      await expect(preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment })).rejects.toThrow('Stop this managed host');
      await expect(configureInstallation(config, f.input, dependencies)).rejects.toThrow('Stop this managed host');
      expect(lock.prepare('SELECT 1 AS alive').get()).toMatchObject({ alive: 1 });
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    await expect(assertHostStopped(layout.stateDirectory)).resolves.toBeUndefined();
  });

  it('checks installed Windows ACL capabilities before making the first private directory', async () => {
    const f = await fixture();
    const { config } = await preflight(f.options, { sourceRoot: f.sourceRoot, environment: f.environment });
    const calls: string[] = [];
    await expect(configureInstallation({ ...config, platform: 'windows' }, f.input, { ...dependencies, privateDirectory: async () => { calls.push('directory'); } })).rejects.toThrow('private-state exports');
    expect(calls).toEqual([]);
  });
});
