import { timingSafeEqual } from 'node:crypto';
import { readFile, stat, open, mkdir, lstat, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { sourceIdSchema } from '@arduano/agent-multiplex-protocol';
import * as storage from '@arduano/agent-multiplex-storage-sqlite';
import { validateWorkHostPairings } from '../packages/work-commands/src/contract.ts';

async function privateDirectory(path) {
  if (process.platform === 'win32') {
    if (!storage.ensurePrivateDirectorySync) throw new Error('Windows ACL update required');
    storage.ensurePrivateDirectorySync(path);
  } else {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe output directory');
    await chmod(path, 0o700);
  }
}

async function readPairing(path) {
  if ((await stat(path)).size > 65536) throw new Error('invalid pairing');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value.version !== 1 || typeof value.sharedSecret !== 'string' || Buffer.byteLength(value.sharedSecret) < 32 || !Array.isArray(value.sources) || !value.sources.length) throw new Error('invalid pairing');
  for (const source of value.sources) {
    sourceIdSchema.parse(source.sourceId);
    if (typeof source.endpointId !== 'string' || !source.endpointId || source.locator?.kind !== 'ticket' || typeof source.locator.ticket !== 'string' || !source.locator.ticket) throw new Error('invalid source');
  }
  return value;
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 3) throw new Error('usage');
  const [existingPath, incomingPath, outputPath] = args.map(value => resolve(value));
  if (outputPath === existingPath || outputPath === incomingPath) throw new Error('output must be new');
  const existing = await readPairing(existingPath);
  const incoming = await readPairing(incomingPath);
  const left = Buffer.from(existing.sharedSecret), right = Buffer.from(incoming.sharedSecret);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('fleet secret mismatch');
  const sources = [...existing.sources];
  for (const source of incoming.sources) {
    const sameId = sources.find(item => item.sourceId === source.sourceId);
    const sameEndpoint = sources.find(item => item.endpointId === source.endpointId);
    if (sameId || sameEndpoint) throw new Error('source already present; review duplicate locally');
    sources.push(source);
  }
  if (new Set(sources.map(source => source.sourceId)).size !== sources.length || new Set(sources.map(source => source.endpointId)).size !== sources.length) throw new Error('duplicate sources');
  const workHosts = validateWorkHostPairings([
    ...validateWorkHostPairings(existing.workHosts, existing.sources),
    ...validateWorkHostPairings(incoming.workHosts, incoming.sources),
  ], sources);
  await privateDirectory(dirname(outputPath));
  const output = await open(outputPath, 'wx', 0o600);
  try { await output.writeFile(JSON.stringify({ ...existing, sources, ...(workHosts.length ? { workHosts } : {}) }, null, 2) + '\n'); await output.sync(); }
  finally { await output.close(); }
  console.log(`Wrote a new private pairing file with ${sources.length} sources. Original files were preserved.`);
} catch {
  console.error('Pairing merge failed. Use: node scripts/merge-pairing.mjs <existing> <incoming> <new-output>. Inputs must share the fleet enrollment secret and have distinct source/endpoint identities. No credentials are printed.');
  process.exitCode = 1;
}
