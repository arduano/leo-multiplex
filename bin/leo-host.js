#!/usr/bin/env node
try {
  const { main } = await import('../dist/apps/host/src/manage.js');
  await main();
} catch {
  console.error('Leo Copilot host could not complete the command. Run leo-host help or leo-host doctor --json; check the local configuration and installed dependencies.');
  process.exitCode = 1;
}
