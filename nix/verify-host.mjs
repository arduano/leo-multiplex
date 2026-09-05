/** Verify a built Nix host without starting services, sessions, or model calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const output = resolve(process.argv[2] ?? 'result');
const application = join(output, 'lib/leo-multiplex');
const require = createRequire(join(application, 'package.json'));
const codexVersion = execFileSync(join(output, 'bin/leo-codex'), ['--version'], { encoding:'utf8' }).trim();
assert.equal(codexVersion, 'codex-cli 0.152.0');
assert.equal(typeof require('node-pty').spawn, 'function');
assert.equal(typeof require('@momics/iroh-http-node').PublicKey, 'function');
const transport = await import(pathToFileURL(join(application, 'node_modules/@arduano/p2prpc-core/dist/index.js')).href);
assert.equal(typeof transport.irohPeerIdJwkThumbprint, 'function');
for (const [file, entry] of [['main.js','runHost'], ['control.js','runHostControl']]) {
  const module = await import(pathToFileURL(join(application, 'dist/apps/host/src', file)).href);
  assert.equal(typeof module[entry], 'function');
}
const sqlite = new DatabaseSync(':memory:');
try { assert.deepEqual(sqlite.prepare('SELECT 1 AS ready').get().ready, 1); }
finally { sqlite.close(); }
assert(!existsSync(join(application, 'node_modules/@github/copilot-linux-x64/webview/node_modules/@webviewjs/webview-linux-x64-gnu')));
assert(!existsSync(join(application, 'node_modules/@koromix/koffi-linux-x64/musl_x64')));
const npmVendor = realpathSync(join(application, 'node_modules/@openai/codex-linux-x64/vendor'));
const binary = realpathSync(join(output, 'bin/leo-codex'));
assert(binary.startsWith(npmVendor + '/'));
const frameworkVersion = JSON.parse(readFileSync(join(application, 'node_modules/@arduano/agent-multiplex-protocol/package.json'), 'utf8')).version;
console.log(JSON.stringify({ output, node:process.version, codexVersion, frameworkVersion, nativeImports:['node-pty','@momics/iroh-http-node','@arduano/p2prpc-core'], hostEntrypointImports:true, sqliteMemoryCheck:true, unusedBinariesExcluded:true, codexPayloadDeduplicated:true, serviceStarts:0, nativeModelCalls:0 }, null, 2));
