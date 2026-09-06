// No models or host state. Bind native Windows CI to actual public release pins.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease } from './install-copilot-host.mjs';

const prefix = '@arduano/agent-multiplex-';
const manifestPath = '.cache/windows-published-release/pack-manifest.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function publishedWindowsGate(packageJson, lock) {
  const version = validateRelease(packageJson, lock, 'wsl');
  if (version === '0.2.0') return { ready: false, version };
  assert.ok(version.localeCompare('0.2.1', undefined, { numeric: true }) >= 0, 'Windows needs framework 0.2.1 or later');
  validateRelease(packageJson, lock, 'windows');
  return { ready: true, version };
}

export function verifyPublishedWindowsManifest(packageJson, lock, manifest) {
  const gate = publishedWindowsGate(packageJson, lock);
  assert.equal(gate.ready, true, 'The published Windows dependency gate is still closed');
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.repository, 'arduano/agent-multiplex');
  assert.equal(manifest.version, gate.version);
  assert.match(manifest.commit ?? '', /^[a-f0-9]{40}$/);
  const names = Object.keys(packageJson.dependencies).filter(name => name.startsWith(prefix)).sort();
  assert.equal(names.length, 16, 'The complete 16-package framework graph must be pinned');
  assert.ok(Array.isArray(manifest.packages));
  assert.deepEqual(manifest.packages.map(entry => entry.name).sort(), names, 'Release package inventory differs from the consumer');
  const artifacts = manifest.packages.map(entry => {
    const locked = lock.packages[`node_modules/${entry.name}`];
    assert.equal(entry.version, gate.version);
    assert.equal(entry.filename, `${entry.name.slice(1).replace('/', '-')}-${gate.version}.tgz`);
    assert.equal(entry.integrity, locked.integrity, `Published integrity differs for ${entry.name}`);
    return { name: entry.name, version: entry.version, integrity: entry.integrity };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { version: gate.version, source: manifest.commit, artifacts };
}

export async function readPublishedWindowsQualification(root, filename, expectedSource) {
  const [packageJson, lock] = await Promise.all(['package.json', 'package-lock.json'].map(async name => JSON.parse(await readFile(join(root, name), 'utf8'))));
  const bytes = await readFile(resolve(root, filename));
  const identity = verifyPublishedWindowsManifest(packageJson, lock, JSON.parse(bytes));
  assert.equal(identity.source, expectedSource, 'Qualification source differs from the published manifest');
  for (const artifact of identity.artifacts) {
    const installed = JSON.parse(await readFile(join(root, 'node_modules', artifact.name, 'package.json'), 'utf8'));
    assert.equal(installed.name, artifact.name);
    assert.equal(installed.version, artifact.version, `Installed package differs for ${artifact.name}`);
  }
  return { ...identity, manifestSha256: digest(bytes) };
}

async function main() {
  assert.equal(process.argv[2], 'prepare', 'Use prepare before the clean dependency install');
  const [packageJson, lock] = await Promise.all(['package.json', 'package-lock.json'].map(async name => JSON.parse(await readFile(name, 'utf8'))));
  const gate = publishedWindowsGate(packageJson, lock);
  if (!gate.ready) {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'ready=false\n');
    console.log('Published Windows qualification skipped: framework 0.2.0 remains pinned. No installation or host startup performed.');
    return;
  }
  const url = `https://github.com/arduano/agent-multiplex/releases/download/v${gate.version}/pack-manifest.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true, 'The pinned public release manifest is unavailable');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length < 1_048_576, 'Release manifest exceeds its size bound');
  const identity = verifyPublishedWindowsManifest(packageJson, lock, JSON.parse(bytes));
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, bytes);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `ready=true\nframework_source=${identity.source}\nmanifest_path=${manifestPath}\n`);
  console.log(`Verified the public ${identity.version} release inventory for ${identity.artifacts.length} locked artifacts at ${identity.source}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Published Windows qualification failed'); process.exitCode = 1; });
}
