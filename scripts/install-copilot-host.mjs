#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const INSTALL_VERSION = 1;
export const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = 'host-install.json';
const FRAMEWORK_PREFIX = '@arduano/agent-multiplex-';
const SHA = /^[a-f0-9]{40}$/i;
const VERSION = String.raw`(\d+\.\d+\.\d+)`;

export function parseInstallerArgs(args) {
  const phase = args[0];
  if (phase !== 'preflight' && phase !== 'configure') throw new Error('Use preflight or configure followed by --platform, --revision and --workspace.');
  const result = { phase, workspaces: [], check: false };
  const keys = { '--platform': 'platform', '--revision': 'revision', '--secret-file': 'secretFile', '--install-dir': 'installDirectory', '--name': 'name', '--github-host': 'githubHost' };
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--check') {
      if (result.check) throw new Error('Duplicate --check option.');
      result.check = true;
    } else if (arg === '--workspace' || keys[arg]) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Installer options require a value.');
      if (arg === '--workspace') result.workspaces.push(value);
      else {
        const key = keys[arg];
        if (result[key] !== undefined) throw new Error('Duplicate installer option.');
        result[key] = value;
      }
    } else throw new Error('Unknown installer option. Run the Windows or WSL installer help.');
  }
  if (!['windows', 'wsl'].includes(result.platform)) throw new Error('--platform must be windows or wsl.');
  if (!SHA.test(result.revision ?? '')) throw new Error('--revision must be the exact full 40-character Git commit SHA.');
  result.revision = result.revision.toLowerCase();
  if (!result.workspaces.length) throw new Error('Supply at least one --workspace absolute directory.');
  result.name ??= `work-${result.platform}`;
  if (!result.name.trim() || result.name.length > 100 || /[\x00-\x1f\x7f]/.test(result.name)) throw new Error('The host name must be nonempty printable text, at most 100 characters.');
  result.githubHost ??= 'github.com';
  if (!/^(github\.com|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com)$/.test(result.githubHost)) throw new Error('--github-host must be github.com or the corporate Enterprise Cloud hostname.');
  return result;
}

export function validatePlatform(target, system) {
  if (system.arch !== 'x64' || Number(system.nodeVersion.split('.')[0]) < 24) throw new Error('Install with native x64 Node.js 24 or newer.');
  if (target === 'windows') {
    if (system.platform !== 'win32') throw new Error('The Windows installer requires native Windows Node.js. Use the WSL installer inside WSL.');
  } else {
    if (system.platform !== 'linux' || !(system.environment.WSL_DISTRO_NAME || /microsoft|wsl/i.test(system.osRelease))) throw new Error('The WSL installer requires a Linux Node.js installation inside WSL.');
    if (!posix.isAbsolute(system.execPath) || /\.exe$/i.test(system.execPath) || /^\/mnt\//i.test(system.execPath)) throw new Error('Install and use Linux Node.js inside WSL; Windows Node.js cannot own this host.');
  }
}

export function validateRelease(packageJson, lock, platform) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('A committed npm lockfile v3 is required.');
  const dependencies = packageJson.dependencies ?? {};
  const framework = Object.entries(dependencies).filter(([name]) => name.startsWith(FRAMEWORK_PREFIX));
  if (!framework.some(([name]) => name === `${FRAMEWORK_PREFIX}storage-sqlite`) || !framework.some(([name]) => name === `${FRAMEWORK_PREFIX}adapter-copilot`)) throw new Error('The published framework dependency graph is incomplete.');
  const versions = new Set();
  for (const [name, url] of [...framework, ['@arduano/p2prpc-core', dependencies['@arduano/p2prpc-core']]]) {
    const project = name === '@arduano/p2prpc-core' ? 'p2prpc' : 'agent-multiplex';
    const archive = name.slice(1).replace('/', '-');
    const match = typeof url === 'string' && url.match(new RegExp(`^https://github\\.com/arduano/${project}/releases/download/v${VERSION}/${archive}-\\1\\.tgz$`));
    const locked = lock.packages[`node_modules/${name}`];
    if (!match || lock.packages[''].dependencies?.[name] !== url || locked?.resolved !== url || locked?.version !== match[1] || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(locked?.integrity ?? '')) throw new Error('Framework and transport dependencies must use exact public release URLs with matching locked integrity.');
    if (packageJson.overrides?.[name] !== undefined && packageJson.overrides[name] !== url) throw new Error('Framework overrides must match the public release pins.');
    if (project === 'agent-multiplex') versions.add(match[1]);
  }
  if (versions.size !== 1) throw new Error('All framework packages must come from one exact release.');
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (entry.link || (!entry.inBundle && (!/^https:\/\//.test(entry.resolved ?? '') || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')))) throw new Error('The lockfile must contain immutable HTTPS artifacts; local, linked and Git dependencies cannot be installed.');
  }
  const version = [...versions][0];
  if (platform === 'windows' && version === '0.2.0') throw new Error('Windows installation is blocked: published framework 0.2.0 lacks the required Windows ACL/storage support. Publish and pin the qualified Windows framework update first; no installation state was changed.');
  return version;
}

export function validateCheckout(sourceRoot, revision, runGit = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()) {
  let root, actual, dirty;
  try {
    root = runGit(['rev-parse', '--show-toplevel']);
    actual = runGit(['rev-parse', 'HEAD']);
    dirty = runGit(['status', '--porcelain', '--untracked-files=no']);
  } catch { throw new Error('Git could not verify this source checkout. Install native Git and use a complete checkout.'); }
  const equalPath = process.platform === 'win32' ? (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase() : (a, b) => resolve(a) === resolve(b);
  if (!equalPath(root, sourceRoot) || actual.toLowerCase() !== revision || dirty) throw new Error('The source checkout must remain at the requested exact revision with no tracked changes. Use a separate clean checkout for this installation.');
}

function within(path, root, paths) {
  const relative = paths.relative(root, path);
  return relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative));
}

export function installationLayout(options, environment = process.env, sourceRoot = SOURCE_ROOT) {
  const paths = options.platform === 'windows' ? win32 : posix;
  const home = (options.platform === 'windows' ? environment.USERPROFILE : environment.HOME) ?? homedir();
  const base = options.platform === 'windows' ? environment.LOCALAPPDATA ?? paths.join(home, 'AppData', 'Local') : environment.XDG_STATE_HOME ?? paths.join(home, '.local', 'state');
  const installDirectory = options.installDirectory ?? paths.join(base, `leo-multiplex-${options.platform}`);
  if (!paths.isAbsolute(installDirectory) || (options.platform === 'windows' && !/^[a-z]:[\\/]/i.test(installDirectory))) throw new Error('The installation directory must be an absolute path on this system’s local filesystem.');
  const install = paths.resolve(installDirectory);
  const forbidden = [sourceRoot, paths.join(home, '.codex'), paths.join(home, '.copilot'), paths.join(base, 'leo-multiplex'), paths.join(base, 'leo-multiplex-copilot'), paths.join(base, `leo-multiplex-${options.platform === 'windows' ? 'wsl' : 'windows'}`)];
  if (install === paths.parse(install).root || install === paths.resolve(home) || forbidden.some(root => within(install, paths.resolve(root), paths) || within(paths.resolve(root), install, paths))) throw new Error('Use a separate installation directory outside the source checkout, ordinary auth homes and other managed hosts.');
  if (options.platform === 'wsl' && /^\/mnt(?:\/|$)/i.test(install)) throw new Error('WSL host state must live in the Linux filesystem, not a Windows/shared mount.');
  const workspaces = [...new Set(options.workspaces.map(root => {
    if (!paths.isAbsolute(root)) throw new Error('Every --workspace must be an absolute directory.');
    return paths.resolve(root);
  }))];
  const stateDirectory = paths.join(install, 'state');
  return { installDirectory: install, configFile: paths.join(install, CONFIG_FILE), stateDirectory, workspaces, environment: {
    LEO_HARNESS: 'copilot', LEO_STATE_DIR: stateDirectory, LEO_HOST_NAME: options.name,
    LEO_ALLOWED_ROOTS: JSON.stringify(workspaces), LEO_COPILOT_GITHUB_HOST: options.githubHost,
    LEO_CONTROL_HTTP_PORT: options.platform === 'windows' ? '4317' : '4319',
    LEO_CONTROL_P2P_BIND: options.platform === 'windows' ? '0.0.0.0:49117' : '0.0.0.0:49119',
    LEO_ENROLL_GATEWAYS: '0', LEO_ENROLL_RUNTIMES: '0',
  } };
}

async function optionalFile(path, maximumBytes = 1024 * 1024) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Installer state must use ordinary files, never symlinks.');
    if (info.size > maximumBytes) throw new Error('An installer configuration or credential file exceeds its supported size.');
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function canonicalProspective(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalProspective(parent), path.slice(parent.length).replace(/^[\\/]/, ''));
  }
}

function secretBuffer(value) {
  const trimmed = value.trim();
  if (Buffer.byteLength(value) > 4096 || Buffer.byteLength(trimmed) < 32 || /\s/.test(trimmed)) throw new Error('The enrollment credential file is invalid.');
  return Buffer.from(trimmed);
}

export async function inspectExistingInstallation(config, secretFile) {
  const current = await optionalFile(join(config.installDirectory, CONFIG_FILE));
  if (current !== undefined) {
    let parsed;
    try { parsed = JSON.parse(current); } catch { throw new Error('The existing installation configuration is invalid; it was not replaced.'); }
    if (JSON.stringify(parsed) !== JSON.stringify(config)) throw new Error('This installation already has a different configuration or source revision. It was not replaced; keep its existing identity and state.');
  }
  const stored = await optionalFile(join(config.environment.LEO_STATE_DIR, 'shared-secret'), 4096);
  if (!secretFile && stored === undefined) throw new Error('The first installation requires --secret-file containing the existing fleet enrollment credential.');
  const incoming = secretFile ? secretBuffer(await optionalFile(secretFile, 4096) ?? '') : undefined;
  const existing = stored === undefined ? undefined : secretBuffer(stored);
  if (incoming && existing && (incoming.length !== existing.length || !timingSafeEqual(incoming, existing))) throw new Error('This host already uses another enrollment credential; no state was replaced.');
  return current !== undefined;
}

export function validateWslFilesystem(directory, mountInfo) {
  const shared = mountInfo.split('\n').some(line => {
    const [info, type] = line.split(' - ');
    const mountpoint = info?.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
    return mountpoint && /^(9p|drvfs|cifs|smb3|nfs4?|fuse\.)\b/.test(type ?? '') && within(directory, mountpoint, posix);
  });
  if (shared) throw new Error('WSL host state must use the Linux filesystem, not a shared mount.');
}

export async function assertHostStopped(stateDirectory) {
  // Read only the framework's separate writer-lock databases, never catalog or
  // vendor history. An active writer holds an exclusive SQLite OS lock.
  for (const relative of ['control/catalog.sqlite.lock.sqlite', 'runtime/runtime-node.sqlite.lock.sqlite']) {
    const filename = join(stateDirectory, relative);
    let info;
    try { info = await lstat(filename); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The host writer lock has an unsafe path; no installation state was changed.');
    const { DatabaseSync } = await import('node:sqlite');
    let database;
    try {
      database = new DatabaseSync(filename, { readOnly: true, timeout: 0 });
      database.prepare('SELECT count(*) FROM sqlite_schema').get();
    } catch { throw new Error('Stop this managed host cleanly before rerunning the installer; its writer lock is active or cannot be verified. No dependencies or host state were changed.'); }
    finally { database?.close(); }
  }
}

export async function preflight(options, context = {}) {
  const environment = context.environment ?? process.env;
  const sourceRoot = await realpath(context.sourceRoot ?? SOURCE_ROOT);
  const platform = context.platform ?? process.platform;
  let osRelease = '';
  if (platform === 'linux') osRelease = await readFile('/proc/sys/kernel/osrelease', 'utf8').catch(() => '');
  validatePlatform(options.platform, { environment, platform, arch: context.arch ?? process.arch, nodeVersion: context.nodeVersion ?? process.versions.node, execPath: context.execPath ?? process.execPath, osRelease });
  if (options.platform === 'wsl') {
    let gitPath;
    try { gitPath = await realpath(execFileSync('/bin/sh', ['-c', 'command -v git'], { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()); }
    catch { throw new Error('Install Linux Git inside WSL.'); }
    if (!posix.isAbsolute(gitPath) || /^\/mnt\//i.test(gitPath) || /\.exe$/i.test(gitPath)) throw new Error('Use Linux Git inside WSL, not Windows Git.');
  }
  validateCheckout(sourceRoot, options.revision, context.runGit);
  const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(sourceRoot, 'package-lock.json'), 'utf8'));
  const frameworkVersion = validateRelease(packageJson, lock, options.platform);
  const layout = installationLayout(options, environment, sourceRoot);
  const canonicalInstall = await canonicalProspective(layout.installDirectory);
  const canonicalState = await canonicalProspective(layout.stateDirectory);
  const pathEqual = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  if (!pathEqual(canonicalInstall, layout.installDirectory) || !pathEqual(canonicalState, layout.stateDirectory)) throw new Error('The installation and state directories must not traverse symlinks or redirected directories.');
  if (options.platform === 'wsl') {
    const mounts = await readFile('/proc/self/mountinfo', 'utf8');
    validateWslFilesystem(canonicalInstall, mounts);
  }
  for (const root of layout.workspaces) {
    if (!(await stat(root).catch(() => undefined))?.isDirectory()) throw new Error('A configured workspace directory does not exist or is inaccessible.');
  }
  const config = { version: INSTALL_VERSION, platform: options.platform, sourceRoot, revision: options.revision, frameworkVersion, installDirectory: layout.installDirectory, environment: layout.environment };
  await inspectExistingInstallation(config, options.secretFile);
  if (context.requireStopped !== false) await assertHostStopped(layout.stateDirectory);
  return { config, layout };
}

export async function configureInstallation(config, secretFile, dependencies) {
  // Everything that can reject an ordinary rerun is checked before the first write.
  await inspectExistingInstallation(config, secretFile);
  await assertHostStopped(config.environment.LEO_STATE_DIR);
  if (config.platform === 'windows' && (typeof dependencies.storage.ensurePrivateDirectorySync !== 'function' || typeof dependencies.storage.assertPrivateFileSync !== 'function')) throw new Error('Installed framework lacks Windows private-state exports. No installation state was changed.');
  await dependencies.privateDirectory(config.installDirectory);
  const lockDirectory = join(config.installDirectory, '.install-lock');
  try { await mkdir(lockDirectory, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('An installation is already configuring this directory. If a previous installer exited unexpectedly, inspect its lock locally before retrying.'); throw error; }
  try {
    const existing = await inspectExistingInstallation(config, secretFile);
    if (secretFile) await dependencies.importEnrollmentSecret(config.environment.LEO_STATE_DIR, secretFile);
    if (!existing) await dependencies.writePrivateFile(join(config.installDirectory, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
    const launcher = await readFile(join(config.sourceRoot, 'scripts', 'installed-copilot-host.mjs'), 'utf8');
    await dependencies.writePrivateFile(join(config.installDirectory, 'leo-host.mjs'), launcher);
  } finally { await rmdir(lockDirectory); }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseInstallerArgs(args);
  const { config } = await preflight(options);
  if (options.phase === 'preflight' || options.check) {
    console.log(`Copilot ${options.platform} preflight passed for ${options.name}. No installation state changed.`);
    return;
  }
  let privateState, enrollment, storage;
  try {
    privateState = await import(pathToFileURL(join(config.sourceRoot, 'dist/apps/host/src/private-state.js')).href);
    enrollment = await import(pathToFileURL(join(config.sourceRoot, 'dist/apps/host/src/enrollment.js')).href);
    storage = await import('@arduano/agent-multiplex-storage-sqlite');
    await stat(join(config.sourceRoot, 'dist/apps/host/src/manage.js'));
  } catch { throw new Error('Run the committed npm ci and production build successfully before configure.'); }
  await configureInstallation(config, options.secretFile, { ...privateState, ...enrollment, storage });
  console.log(`Copilot ${options.platform} host configured. Launcher: ${join(config.installDirectory, 'leo-host.mjs')}\nUse login, doctor, then start --enroll for first pairing. Normal start keeps enrollment closed. No login or host process was started.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Copilot installer failed.'); process.exitCode = 1; });
}
