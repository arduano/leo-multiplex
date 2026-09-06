import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { publishedWindowsGate, readPublishedWindowsQualification, verifyPublishedWindowsManifest } from '../scripts/qualify-published-windows.mjs';

async function fixture(version = '0.2.1') {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const names = Object.keys(pkg.dependencies).filter(name => name.startsWith('@arduano/agent-multiplex-'));
  const packages = names.map(name => {
    const filename = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
    const url = `https://github.com/arduano/agent-multiplex/releases/download/v${version}/${filename}`;
    pkg.dependencies[name] = pkg.overrides[name] = lock.packages[''].dependencies[name] = url;
    const entry = lock.packages[`node_modules/${name}`];
    entry.version = version; entry.resolved = url;
    return { name, version, filename, integrity: entry.integrity };
  });
  const manifest = { schemaVersion: 2, repository: 'arduano/agent-multiplex', version, commit: 'a'.repeat(40), packages };
  return { pkg, lock, manifest };
}

it('leaves old public Windows artifacts unqualified without downloading or starting a host', async () => {
  const { pkg, lock, manifest } = await fixture('0.2.0');
  expect(publishedWindowsGate(pkg, lock)).toEqual({ ready: false, version: '0.2.0' });
  expect(() => verifyPublishedWindowsManifest(pkg, lock, manifest)).toThrow('gate is still closed');
});

it('binds the complete published artifact inventory to exact consumer pins and source', async () => {
  const { pkg, lock, manifest } = await fixture();
  const identity = verifyPublishedWindowsManifest(pkg, lock, manifest);
  expect(identity.source).toBe(manifest.commit);
  expect(identity.version).toBe('0.2.1');
  expect(identity.artifacts).toHaveLength(16);
});

it('rejects a published release whose bytes differ from the consumer lock', async () => {
  const { pkg, lock, manifest } = await fixture();
  manifest.packages[0].integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
  expect(() => verifyPublishedWindowsManifest(pkg, lock, manifest)).toThrow('Published integrity differs');
});

it('rejects an incomplete, duplicated or unrelated release inventory', async () => {
  const { pkg, lock, manifest } = await fixture();
  expect(() => verifyPublishedWindowsManifest(pkg, lock, { ...manifest, packages: manifest.packages.slice(1) })).toThrow('inventory differs');
  expect(() => verifyPublishedWindowsManifest(pkg, lock, { ...manifest, packages: [...manifest.packages.slice(1), manifest.packages[1]] })).toThrow('inventory differs');
  expect(() => verifyPublishedWindowsManifest(pkg, lock, { ...manifest, repository: 'someone/other' })).toThrow();
  expect(() => verifyPublishedWindowsManifest(pkg, lock, { ...manifest, commit: 'main' })).toThrow();
});

it('rejects release version or tarball identity drift', async () => {
  const { pkg, lock, manifest } = await fixture();
  expect(() => verifyPublishedWindowsManifest(pkg, lock, { ...manifest, version: '0.2.2' })).toThrow();
  manifest.packages[0].filename = 'other.tgz';
  expect(() => verifyPublishedWindowsManifest(pkg, lock, manifest)).toThrow();
});

it('refuses to label an old installed graph or mismatched source as a published qualification', async () => {
  const { pkg, lock, manifest } = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'leo-published-windows-test-'));
  try {
    for (const [name, value] of Object.entries({ 'package.json': pkg, 'package-lock.json': lock, 'release.json': manifest })) await writeFile(join(root, name), JSON.stringify(value));
    for (const artifact of manifest.packages) {
      const path = join(root, 'node_modules', artifact.name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'package.json'), JSON.stringify({ name: artifact.name, version: artifact.version }));
    }
    const qualified = await readPublishedWindowsQualification(root, 'release.json', manifest.commit);
    expect(qualified.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(readPublishedWindowsQualification(root, 'release.json', 'b'.repeat(40))).rejects.toThrow('source differs');
    const artifact = manifest.packages[0];
    await writeFile(join(root, 'node_modules', artifact.name, 'package.json'), JSON.stringify({ name: artifact.name, version: '0.2.0' }));
    await expect(readPublishedWindowsQualification(root, 'release.json', manifest.commit)).rejects.toThrow('Installed package differs');
  } finally { await rm(root, { recursive: true, force: true }); }
});
