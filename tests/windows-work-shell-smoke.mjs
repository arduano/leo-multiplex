// Dependency-free qualification of the exact shipped PowerShell/process-job
// wrapper. This does not qualify the separately release-gated SQLite executor.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsWorkCommandInvocation } from "../packages/work-commands/src/windows-shell.ts";

assert.equal(process.platform, "win32");
const directory = await mkdtemp(join(tmpdir(), "leo-shell-fixture-"));
const literal = text => `'${text.replaceAll("'", "''")}'`;
let checks = 0;
let sequence = 0;
async function execute(command, onStart) {
  const filename = join(directory, `command ${sequence++}.txt`);
  await writeFile(filename, command, "utf8");
  const { file, args } = windowsWorkCommandInvocation(filename, process.env);
  assert.ok(!args.some(arg => /executionpolicy|bypass/i.test(arg)));
  const child = spawn(file, args, { cwd: directory, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
    await onStart?.(child);
    return await completion;
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); }
}
async function awaitPid(filename) {
  for (let n = 0; n < 300; n++) {
    try { const pid = Number(await readFile(filename, "utf8")); if (pid > 0) return pid; } catch { /* fixture starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Fixture child did not start");
}
try {
  const result = await execute("[Console]::Write('héllo 🙂'); [Console]::Error.Write('fixture warning'); exit 7");
  assert.deepEqual(result, { code: 7, signal: null, stdout: "héllo 🙂", stderr: "fixture warning" }); checks++;
  assert.equal((await execute("Write-Error 'fixture failure'")).code, 1); checks++;
  const text = "x".repeat(16_000);
  assert.equal((await execute(`[Console]::Write('${text}')`)).stdout, text); checks++;
  for (const interrupted of [false, true]) {
    const pidFile = join(directory, `child-${interrupted}.pid`);
    const program = '"setTimeout(() => {}, 30000)"';
    let pid;
    const command = `$child = Start-Process -FilePath ${literal(process.execPath)} -ArgumentList '-e', ${literal(program)} -NoNewWindow -PassThru; [IO.File]::WriteAllText(${literal(pidFile)}, [string]$child.Id); ${interrupted ? "Start-Sleep -Seconds 30" : "exit 0"}`;
    await execute(command, interrupted ? async child => { pid = await awaitPid(pidFile); child.kill(); } : undefined);
    pid ??= await awaitPid(pidFile);
    // A killed shell closes its job handle, including when Node forcibly stops
    // that shell. Process IDs are read only from this disposable owned child.
    const state = await execute(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [Console]::Write('alive') }`);
    assert.equal(state.stdout, ""); checks++;
  }
  console.log(`Windows work shell: ${checks} checks passed`);
} finally { await rm(directory, { recursive: true, force: true }); }
