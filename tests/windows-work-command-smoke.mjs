// Native harmless process checks; no authentication, native agents or model calls.
// Run after npm run build and the CI-only tested Windows framework overlay.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createWorkCommandExecutor } from "../dist/packages/work-commands/src/executor.js";

assert.equal(process.platform, "win32", "This smoke test must run on native Windows");
const directory = await mkdtemp(join(tmpdir(), "leo-work-command-smoke-"));
const stateDirectory = join(directory, "private state");
const execFileAsync = promisify(execFile);
const psLiteral = text => `'${text.replaceAll("'", "''")}'`;
const request = (command, timeoutMs = 15_000) => ({ operationId: randomUUID(), cwd: directory, command, timeoutMs });
let executor;
let checks = 0;
const waitFor = async predicate => {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Native Windows work-command check timed out");
};
const finished = operationId => waitFor(async () => {
  const record = await executor.get(operationId);
  return record?.state !== "running" ? record : null;
});
try {
  executor = await createWorkCommandExecutor({ stateDirectory, allowedRoots: [directory], platform: "windows", environment: {
    ...process.env, LEO_TEST_SECRET: "fixture-private", OPENAI_API_KEY: "fixture-private", GH_TOKEN: "fixture-private", WORK_COMMAND_FIXTURE: "visible",
  } });
  const first = request("[Console]::Write('héllo 🙂'); [Console]::Error.Write('fixture stderr'); exit 7");
  await executor.submit(first);
  const firstRecord = await finished(first.operationId);
  assert.equal(firstRecord.state, "completed");
  assert.equal(firstRecord.exitCode, 7);
  assert.equal(firstRecord.stdout, "héllo 🙂");
  assert.equal(firstRecord.stderr, "fixture stderr");
  checks++;
  assert.deepEqual(await executor.submit(first), firstRecord);
  await assert.rejects(executor.submit({ ...first, command: "Write-Output changed" }), { code: "REQUEST_CONFLICT" });
  checks++;

  const environment = request("[Console]::Write(\"$env:LEO_TEST_SECRET|$env:OPENAI_API_KEY|$env:GH_TOKEN|$env:WORK_COMMAND_FIXTURE\")");
  await executor.submit(environment);
  assert.equal((await finished(environment.operationId)).stdout, "|||visible");
  checks++;

  const output = request("[Console]::Write(('x' * 200000)); [Console]::Error.Write('tail')");
  await executor.submit(output);
  const bounded = await finished(output.operationId);
  assert.equal(bounded.exitCode, 0);
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.stdout) + Buffer.byteLength(bounded.stderr) <= 128 * 1024);
  checks++;

  const busy = request("Start-Sleep -Seconds 30");
  await executor.submit(busy);
  const rejected = request("Write-Output unwanted");
  await assert.rejects(executor.submit(rejected), { code: "BUSY" });
  assert.equal(await executor.get(rejected.operationId), null);
  assert.equal((await executor.cancel(busy.operationId)).state, "cancelled");
  checks++;

  const timeout = request("Start-Sleep -Seconds 30", 1_000);
  await executor.submit(timeout);
  assert.equal((await finished(timeout.operationId)).state, "timedOut");
  checks++;

  // A shell which launches a new native child and exits must not leave that
  // child behind. The Windows kernel job kills it when the shell handle closes.
  const pidFile = join(directory, "child-pid");
  const childProgram = "setTimeout(() => {}, 30000)";
  const descendant = request(`$child = Start-Process -FilePath ${psLiteral(process.execPath)} -ArgumentList '-e', ${psLiteral('"' + childProgram + '"')} -NoNewWindow -PassThru; [IO.File]::WriteAllText(${psLiteral(pidFile)}, [string]$child.Id); [Console]::Write('parent done')`);
  await executor.submit(descendant);
  const descendantRecord = await finished(descendant.operationId);
  assert.equal(descendantRecord.state, "completed");
  assert.equal(descendantRecord.exitCode, 0);
  assert.equal(descendantRecord.stdout, "parent done");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const alive = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' }`]);
  assert.equal(alive.stdout.trim(), "");
  checks++;

  await executor.close();
  executor = await createWorkCommandExecutor({ stateDirectory, allowedRoots: [directory], platform: "windows" });
  assert.deepEqual(await executor.get(first.operationId), firstRecord);
  checks++;
  console.log(`Windows work-command smoke: ${checks} checks passed`);
} finally {
  await executor?.close();
  await rm(directory, { recursive: true, force: true });
}
