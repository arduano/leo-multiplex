// CI-only source qualification. Never produces a deployment or edits dependency manifests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.equal(process.env.CI, 'true', 'candidate staging is restricted to disposable CI');
const framework = resolve(process.argv[2]);
const expected = process.env.LEO_QUALIFICATION_FRAMEWORK_SHA;
assert.match(expected ?? '', /^[a-f0-9]{40}$/);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: framework, encoding: 'utf8' }).trim(), expected);
const root = JSON.parse(await readFile(join(framework, 'package.json'), 'utf8'));
assert.equal(root.name, 'agent-multiplex');
for (const workspace of root.workspaces) {
  assert.match(workspace, /^(apps|packages)\/[a-z0-9-]+$/);
  const manifest = JSON.parse(await readFile(join(framework, workspace, 'package.json'), 'utf8'));
  assert.match(manifest.name, /^@arduano\/agent-multiplex-[a-z0-9-]+$/);
  const target = resolve('node_modules', manifest.name, 'dist');
  await rm(target, { recursive: true, force: true });
  await cp(join(framework, workspace, 'dist'), target, { recursive: true });
}
console.log('Staged exact framework build for source-only Windows qualification; manifests and public pins are unchanged.');
