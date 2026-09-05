#!/usr/bin/env node
try {
  await import('../dist/apps/agent-cli/src/main.js');
} catch (error) {
  process.stdout.write(JSON.stringify({ version: 1, ok: false, error: { code: 'CLI_UNAVAILABLE', message: error?.code === 'ERR_MODULE_NOT_FOUND' ? 'Build this checkout with npm run build before running leo-agents.' : 'The CLI could not start.' } }) + '\n');
  process.exitCode = 2;
}
