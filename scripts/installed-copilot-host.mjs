#!/usr/bin/env node
// Copied into the private installation directory. All executable code remains
// in the exact clean source checkout; no credential is stored in this launcher.
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function validateHostCommand(args) {
  const command = args[0] ?? 'help';
  const rest = args.slice(1);
  if (['help', '--help', 'pairing'].includes(command) && rest.length === 0) return [command];
  if (command === 'doctor' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--json'))) return args;
  if (command === 'start' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--enroll'))) return args;
  if (command === 'command-recovery' && rest.length === 2 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(rest[0]) && rest[1] === '--processes-inspected') return args;
  if (command === 'init' && rest.length === 2 && rest[0] === '--secret-file' && rest[1] && !rest[1].startsWith('--')) return args;
  if (command === 'login') {
    const seen = new Set();
    for (let index = 0; index < rest.length; index++) {
      const option = rest[index];
      if (seen.has(option)) throw new Error('Duplicate login option.');
      seen.add(option);
      if (option === '--device-code') continue;
      if (option === '--host' && /^https:\/\/(?:github\.com|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com)\/?$/.test(rest[++index] ?? '')) continue;
      throw new Error('Use login [--device-code] [--host https://company.ghe.com].');
    }
    return args;
  }
  throw new Error('Use help, login, doctor, start, pairing, init, or command-recovery. Arbitrary Node/native commands are not accepted.');
}

export function installedEnvironment(config, environment = process.env) {
  const allowed = ['LEO_HARNESS', 'LEO_STATE_DIR', 'LEO_HOST_NAME', 'LEO_ALLOWED_ROOTS', 'LEO_COPILOT_GITHUB_HOST', 'LEO_CONTROL_HTTP_PORT', 'LEO_CONTROL_P2P_BIND', 'LEO_ENROLL_GATEWAYS', 'LEO_ENROLL_RUNTIMES'];
  if (config.version !== 1 || !['windows', 'wsl'].includes(config.platform) || !/^[a-f0-9]{40}$/.test(config.revision ?? '') || typeof config.sourceRoot !== 'string' || typeof config.installDirectory !== 'string' || typeof config.environment !== 'object' || config.environment === null || Object.keys(config.environment).length !== allowed.length || allowed.some(key => typeof config.environment[key] !== 'string') || Object.keys(config.environment).some(key => !allowed.includes(key))) throw new Error('The installed host configuration is invalid.');
  if (config.environment.LEO_HARNESS !== 'copilot' || config.environment.LEO_ENROLL_GATEWAYS !== '0' || config.environment.LEO_ENROLL_RUNTIMES !== '0') throw new Error('The installation must use Copilot with enrollment closed by default.');
  for (const [key, value] of Object.entries(environment)) {
    if (/^LEO_/i.test(key) && value !== undefined && config.environment[key.toUpperCase()] !== value) throw new Error('Conflicting inherited LEO settings are present. Clear them before using this installed host.');
  }
  return {
    // Retain corporate proxy/CA and normal OS variables. The managed host's
    // own Copilot environment performs the same credential isolation again.
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(LEO_|AGENT_MULTIPLEX_|CODEX_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|COPILOT_)/i.test(key) && !/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|NODE_OPTIONS)$/i.test(key))),
    ...config.environment,
  };
}

export async function main(args = process.argv.slice(2), installDirectory = dirname(fileURLToPath(import.meta.url))) {
  const command = validateHostCommand(args);
  const configPath = join(installDirectory, 'host-install.json');
  const info = await lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('The installed configuration must be a private regular file.');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const environment = installedEnvironment(config);
  const actualDirectory = resolve(await realpath(installDirectory));
  if ((process.platform === 'win32' ? resolve(config.installDirectory).toLowerCase() !== actualDirectory.toLowerCase() : resolve(config.installDirectory) !== actualDirectory)) throw new Error('The installation directory moved; use its original private location.');
  try {
    await lstat(join(installDirectory, '.install-lock'));
    throw new Error('An installer is configuring this host; wait for it to finish before running a command.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let revision, dirty;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: config.sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { throw new Error('The installed source checkout is unavailable. Restore its exact revision and keep its original location.'); }
  if (revision !== config.revision || dirty) throw new Error('The installed source revision changed or has tracked modifications. Restore the exact clean revision; the host was not started.');
  const installer = await import(pathToFileURL(join(config.sourceRoot, 'scripts/install-copilot-host.mjs')).href);
  const roots = JSON.parse(config.environment.LEO_ALLOWED_ROOTS);
  if (roots !== '*' && (!Array.isArray(roots) || roots.length === 0 || roots.some(root => typeof root !== 'string'))) throw new Error('The saved working-directory policy is invalid.');
  const options = installer.parseInstallerArgs(['preflight', '--platform', config.platform, '--revision', config.revision, '--install-dir', config.installDirectory, '--name', config.environment.LEO_HOST_NAME, '--github-host', config.environment.LEO_COPILOT_GITHUB_HOST, ...(roots === '*' ? [] : roots.flatMap(root => ['--workspace', root]))]);
  // Recheck source, release boundary, directories and persisted settings before
  // native startup, including after a laptop wakes or source is accidentally moved.
  await installer.preflight(options, { sourceRoot: config.sourceRoot, environment, requireStopped: false });
  if (config.platform === 'windows') {
    const storagePath = join(config.sourceRoot, 'dist/apps/host/src/private-state.js');
    const { verifyPrivateTarget } = await import(pathToFileURL(storagePath).href);
    await verifyPrivateTarget(configPath);
  }
  // One process receives native console Ctrl+C on both Windows and Linux. The
  // management entrypoint owns graceful control/runtime shutdown itself.
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
  process.chdir(config.sourceRoot);
  const management = await import(pathToFileURL(join(config.sourceRoot, 'dist/apps/host/src/manage.js')).href);
  await management.main(command, environment);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('The installed Copilot host could not run. Check its private configuration, unchanged source revision and native Node/Git installation.'); process.exitCode = 1; });
}
