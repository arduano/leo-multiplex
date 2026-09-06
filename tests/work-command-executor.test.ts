import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { acknowledgeWorkCommandRecovery, createWorkCommandExecutor, MAX_JOURNAL_OPERATIONS, windowsWorkCommandInvocation, workCommandEnvironment } from "../packages/work-commands/src/executor.js";
import { MAX_OUTPUT_BYTES, type WorkCommandExecutor, type WorkCommandRequest } from "../packages/work-commands/src/contract.js";

const directories: string[] = [];
const executors: WorkCommandExecutor[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const request = (cwd: string, command: string, overrides: Partial<WorkCommandRequest> = {}): WorkCommandRequest => ({ operationId: randomUUID(), cwd, command, timeoutMs: 5_000, ...overrides });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "leo-work-command-"));
  directories.push(directory);
  const stateDirectory = join(directory, "state");
  const workspace = join(directory, "work spaces");
  await mkdir(workspace);
  return { directory, workspace, stateDirectory, options: { stateDirectory, allowedRoots: [workspace], platform: "wsl" as const } };
}
async function open(options: Parameters<typeof createWorkCommandExecutor>[0]) {
  const executor = await createWorkCommandExecutor(options);
  executors.push(executor);
  return executor;
}
async function finished(executor: WorkCommandExecutor, operationId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = await executor.get(operationId);
    if (record && record.state !== "running") return record;
    await sleep(20);
  }
  throw new Error("Fixture work command did not finish");
}
async function fileText(filename: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return await readFile(filename, "utf8"); } catch { await sleep(20); }
  }
  throw new Error("Fixture file was not written");
}
afterEach(async () => {
  await Promise.all(executors.splice(0).map(executor => executor.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("private work-laptop command executor", () => {
  it("allows operator-selected existing directories outside explicit roots when unrestricted, while rejecting invalid cwd", async () => {
    const { options, directory, workspace } = await fixture();
    const executor = await open({ ...options, allowedRoots: [], unrestrictedPaths: true });
    for (const cwd of [workspace, directory]) {
      const item = request(cwd, "pwd");
      await executor.submit(item);
      expect(await finished(executor, item.operationId)).toMatchObject({ exitCode: 0, stdout: `${cwd}\n` });
    }
    for (const cwd of ["relative", join(directory, "missing"), join(options.stateDirectory, "operations.sqlite")]) {
      await expect(executor.submit(request(cwd, "exit 0"))).rejects.toMatchObject({ code: "INVALID_CWD" });
    }
  });
  it("captures stdout, stderr and native nonzero exit with canonical approved cwd", async () => {
    const { options, workspace, stateDirectory } = await fixture();
    const executor = await open(options);
    const item = request(workspace, "printf 'hello'; printf 'warning' >&2; pwd; exit 7");
    expect(await executor.submit(item)).toMatchObject({ ...item, state: "running" });
    const record = await finished(executor, item.operationId);
    expect(record).toMatchObject({ state: "completed", exitCode: 7, stderr: "warning", stdout: `hello${workspace}\n`, truncated: false });
    expect(record.finishedAt).not.toBeNull();
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDirectory, "operations.sqlite"))).mode & 0o777).toBe(0o600);
    await executor.close();
    const reopened = await open(options);
    expect(await reopened.submit(item)).toEqual(record);
  });

  it("admits one concurrent duplicate, rejects a busy distinct command without journaling, and refuses conflicting reuse", async () => {
    const { options, workspace } = await fixture();
    const executor = await open(options);
    const item = request(workspace, "printf 'one\n' >> count; sleep 0.3");
    const receipts = await Promise.all(Array.from({ length: 8 }, () => executor.submit(item)));
    expect(new Set(receipts.map(receipt => receipt.createdAt)).size).toBe(1);
    const busy = request(workspace, "printf 'unwanted'");
    await expect(executor.submit(busy)).rejects.toMatchObject({ code: "BUSY" });
    expect(await executor.get(busy.operationId)).toBeNull();
    await expect(executor.submit({ ...item, command: "printf 'different'" })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await finished(executor, item.operationId);
    expect(await readFile(join(workspace, "count"), "utf8")).toBe("one\n");
    await executor.submit(busy);
    expect(await finished(executor, busy.operationId)).toMatchObject({ stdout: "unwanted" });
  });

  it("caps combined output at 128 KiB, drains excess to allow completion and does not split UTF-8 codepoints", async () => {
    const { options, workspace } = await fixture();
    const executor = await open(options);
    const script = "process.stdout.write('🙂'.repeat(100000));process.stderr.write('tail');";
    const item = request(workspace, `${shellQuote(process.execPath)} -e ${shellQuote(script)}`);
    await executor.submit(item);
    const record = await finished(executor, item.operationId);
    expect(record).toMatchObject({ state: "completed", exitCode: 0, truncated: true });
    expect(Buffer.byteLength(record.stdout) + Buffer.byteLength(record.stderr)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(record.stdout).not.toContain("�");
    expect(record.stdout.length).toBeGreaterThan(1000);
  });

  it("times out a command and waits for its owned process group to die", async () => {
    const { options, workspace } = await fixture();
    const executor = await open(options);
    const item = request(workspace, "printf '%s' $$ > pid; trap '' TERM; sleep 30", { timeoutMs: 1_000 });
    await executor.submit(item);
    const pid = Number(await fileText(join(workspace, "pid")));
    const record = await finished(executor, item.operationId);
    expect(record).toMatchObject({ state: "timedOut", signal: "SIGKILL" });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("cancels only the matching owned command and preserves the cancellation receipt on retry", async () => {
    const { options, workspace } = await fixture();
    const executor = await open(options);
    const item = request(workspace, "printf 'started'; sleep 30");
    await executor.submit(item);
    expect(await executor.cancel(randomUUID())).toBeNull();
    const record = await executor.cancel(item.operationId);
    expect(record).toMatchObject({ state: "cancelled" });
    expect(await executor.cancel(item.operationId)).toEqual(record);
    expect(await executor.submit(item)).toEqual(record);
    const next = request(workspace, "printf 'next'");
    await executor.submit(next);
    expect(await finished(executor, next.operationId)).toMatchObject({ stdout: "next", exitCode: 0 });
  });

  it("reaps a background descendant retaining pipes when its shell exits instead of prematurely declaring completion", async () => {
    const { options, workspace } = await fixture();
    const executor = await open(options);
    const item = request(workspace, "sleep 30 & printf '%s' $! > descendant; printf 'parent done'");
    await executor.submit(item);
    const descendant = Number(await fileText(join(workspace, "descendant")));
    expect(await finished(executor, item.operationId)).toMatchObject({ state: "completed", stdout: "parent done", exitCode: 0 });
    try {
      const contents = await readFile(`/proc/${descendant}/stat`, "utf8");
      expect(contents.slice(contents.lastIndexOf(")") + 2).split(" ")[0]).toBe("Z");
    } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ENOENT"); }
  });

  it("removes service/provider credentials and shell startup injection while retaining user tools, proxy and CA settings", async () => {
    const { options, workspace } = await fixture();
    const executor = await open({ ...options, environment: {
      ...process.env, LEO_FLEET_SECRET: "fixture-service-token", CODEX_HOME: "/fixture-personal", OPENAI_API_KEY: "fixture-openai",
      COPILOT_GITHUB_TOKEN: "fixture-copilot", GH_TOKEN: "fixture-gh", GITHUB_TOKEN: "fixture-github", NODE_OPTIONS: "--bad-option",
      BASH_ENV: "/fixture-shell-injection", HTTP_PROXY: "http://fixture-proxy.test", NODE_EXTRA_CA_CERTS: "/fixture-ca.pem", WORK_FIXTURE: "tools-present",
    } });
    const item = request(workspace, "printf '%s' \"$LEO_FLEET_SECRET|$CODEX_HOME|$OPENAI_API_KEY|$COPILOT_GITHUB_TOKEN|$GH_TOKEN|$GITHUB_TOKEN|$NODE_OPTIONS|$BASH_ENV|$HTTP_PROXY|$NODE_EXTRA_CA_CERTS|$WORK_FIXTURE\"");
    await executor.submit(item);
    expect((await finished(executor, item.operationId)).stdout).toBe("||||||||http://fixture-proxy.test|/fixture-ca.pem|tools-present");
  });

  it("rejects relative, missing, sibling-prefix and symlink-escape cwd without creating receipts", async () => {
    const { options, workspace, directory } = await fixture();
    const outside = `${workspace}-outside`;
    await mkdir(outside);
    await symlink(outside, join(workspace, "escape"));
    const executor = await open(options);
    for (const cwd of [".", join(workspace, "missing"), outside, join(workspace, "escape"), directory]) {
      const item = request(cwd, "printf unwanted");
      await expect(executor.submit(item)).rejects.toMatchObject({ code: "INVALID_CWD" });
      expect(await executor.get(item.operationId)).toBeNull();
    }
  });

  it("enforces UTF-8 command bytes and timeout bounds before admission", async () => {
    const { options, workspace } = await fixture();
    const executor = await open(options);
    for (const item of [request(workspace, "🙂".repeat(5_000)), request(workspace, "true", { timeoutMs: 999 }), request(workspace, "true", { timeoutMs: 300_001 })]) {
      await expect(executor.submit(item)).rejects.toThrow();
      expect(await executor.get(item.operationId)).toBeNull();
    }
  });

  it("holds the journal writer lock across executor instances and closes active commands before releasing it", async () => {
    const { options, workspace } = await fixture();
    const executor = await open(options);
    await expect(createWorkCommandExecutor(options)).rejects.toMatchObject({ code: "WRITER_LOCKED" });
    const item = request(workspace, "sleep 30");
    await executor.submit(item);
    await executor.close();
    const reopened = await open(options);
    expect(await reopened.get(item.operationId)).toMatchObject({ state: "cancelled" });
  });

  it("keeps interrupted operations unknown across restart and demands stopped-service local recovery without rerunning them", async () => {
    const { options, workspace } = await fixture();
    const item = request(workspace, "printf '%s' $$ > interrupted-pid; printf 'once\n' >> effects; exec sleep 30", { timeoutMs: 30_000 });
    const executorModule = resolve("packages/work-commands/src/executor.ts");
    const program = `import {createWorkCommandExecutor} from ${JSON.stringify(executorModule)}; const executor = await createWorkCommandExecutor(${JSON.stringify(options)}); await executor.submit(${JSON.stringify(item)}); console.log('admitted');`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe"] });
    let shellPid = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", chunk => { if (String(chunk).includes("admitted")) resolve(); });
        child.on("error", reject); child.on("exit", () => reject(new Error("Fixture exited before admission")));
      });
      shellPid = Number(await fileText(join(workspace, "interrupted-pid")));
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("close", resolve));
      const executor = await open(options);
      expect(await executor.get(item.operationId)).toMatchObject({ state: "outcomeUnknown" });
      expect(await executor.submit(item)).toMatchObject({ state: "outcomeUnknown" });
      await expect(executor.submit(request(workspace, "true"))).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      await expect(acknowledgeWorkCommandRecovery(options.stateDirectory, item.operationId)).rejects.toMatchObject({ code: "WRITER_LOCKED" });
      await executor.close();
      process.kill(-shellPid, "SIGKILL");
      shellPid = 0;
      await acknowledgeWorkCommandRecovery(options.stateDirectory, item.operationId);
      const recovered = await open(options);
      expect(await recovered.submit(item)).toMatchObject({ state: "outcomeUnknown" });
      const next = request(workspace, "printf 'recovered'");
      await recovered.submit(next);
      expect(await finished(recovered, next.operationId)).toMatchObject({ stdout: "recovered" });
      expect(await readFile(join(workspace, "effects"), "utf8")).toBe("once\n");
    } finally {
      child.kill("SIGKILL");
      if (shellPid) { try { process.kill(-shellPid, "SIGKILL"); } catch { /* Already dead. */ } }
    }
  });

  it("rejects new work at journal capacity while keeping completed operation IDs replayable", async () => {
    const { options, workspace, stateDirectory } = await fixture();
    const executor = await open(options);
    const first = request(workspace, "printf once");
    await executor.submit(first);
    const record = await finished(executor, first.operationId);
    await executor.close();
    const database = new DatabaseSync(join(stateDirectory, "operations.sqlite"));
    try {
      database.exec("BEGIN");
      const insert = database.prepare("INSERT INTO operations(operation_id, record_json) VALUES (?, ?)");
      for (let i = 1; i < MAX_JOURNAL_OPERATIONS; i++) {
        const operationId = randomUUID();
        insert.run(operationId, JSON.stringify({ ...record, operationId }));
      }
      database.exec("COMMIT");
    } finally { database.close(); }
    const reopened = await open(options);
    await expect(reopened.submit(request(workspace, "printf unwanted"))).rejects.toMatchObject({ code: "JOURNAL_FULL" });
    expect(await reopened.submit(first)).toEqual(record);
  });

  it("refuses symlink state and broad SQLite file permissions", async () => {
    const { options, workspace, directory, stateDirectory } = await fixture();
    await symlink(workspace, stateDirectory);
    await expect(createWorkCommandExecutor(options)).rejects.toThrow();
    await rm(stateDirectory);
    const executor = await open(options);
    await executor.close();
    await chmod(join(stateDirectory, "operations.sqlite"), 0o644);
    await expect(createWorkCommandExecutor(options)).rejects.toThrow();
    expect(await readFile(join(directory, "state", "operations.sqlite"))).not.toHaveLength(0);
  });
});

describe("Windows command construction", () => {
  it("uses explicit system PowerShell, an encoded command and kernel kill-on-close job without policy bypass", () => {
    const invocation = windowsWorkCommandInvocation("C:\\Users\\Work Person\\Leo's state\\fixture.command", { SystemRoot: "C:\\Windows" });
    expect(invocation.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(invocation.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand"]);
    const script = Buffer.from(invocation.args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("Leo''s state");
    expect(script).toContain("AssignProcessToJobObject");
    expect(script).toContain("LimitFlags = 0x2000");
    expect(script).not.toMatch(/ExecutionPolicy|RunAs|Bypass/i);
    expect(() => windowsWorkCommandInvocation("C:\\fixture.command", { SystemRoot: "relative" })).toThrow();
  });

  it("filters Windows environment names case-insensitively without losing corporate networking", () => {
    expect(workCommandEnvironment({ leo_secret: "private", OpenAI_Api_Key: "private", Gh_Token: "private", Path: "tools", HTTPS_PROXY: "fixture", NODE_EXTRA_CA_CERTS: "ca" }))
      .toEqual({ Path: "tools", HTTPS_PROXY: "fixture", NODE_EXTRA_CA_CERTS: "ca" });
  });
});
