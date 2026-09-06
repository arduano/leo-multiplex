import { windowsWorkCommandInvocation } from "./windows-shell.js";
export { windowsWorkCommandInvocation } from "./windows-shell.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { HardenedSqliteDatabase } from "@arduano/agent-multiplex-storage-sqlite";
import { privateDirectory, verifyPrivateTarget, writePrivateFile } from "../../../apps/host/src/private-state.js";
import { MAX_COMMAND_BYTES, MAX_OUTPUT_BYTES, workCommandIdSchema, workCommandRecordSchema, workCommandRequestSchema, type WorkCommandExecutor, type WorkCommandRecord, type WorkCommandRequest } from "./contract.js";

export interface WorkCommandExecutorOptions {
  stateDirectory: string;
  allowedRoots: readonly string[];
  /** Trusted work-host setup, independent of command input. */
  unrestrictedPaths?: boolean;
  platform: "windows" | "wsl";
  environment?: NodeJS.ProcessEnv;
}

export const MAX_JOURNAL_OPERATIONS = 1_000;
const APPLICATION_ID = 0x4c574331; // LWC1: private Leo work-command journal, not a domain catalog.
const TERMINATE_GRACE_MS = 1_000;
const TERMINATE_DEADLINE_MS = 5_000;
const OUTPUT_FLUSH_MS = 250;

export class WorkCommandError extends Error {
  constructor(readonly code: "BUSY" | "REQUEST_CONFLICT" | "RECOVERY_REQUIRED" | "JOURNAL_FULL" | "INVALID_CWD" | "CLOSED", message: string) {
    super(message);
    this.name = "WorkCommandError";
  }
}

/** These commands deliberately have the user's OS access, without ambient service/provider secrets. */
export function workCommandEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined &&
    !/^(?:LEO_|AGENT_MULTIPLEX_|CODEX_|OPENAI_|COPILOT_|GITHUB_|GH_|ANTHROPIC_|AZURE_OPENAI_|AZURE_AI_|AWS_|GOOGLE_API_|GEMINI_)/i.test(key) &&
    !/^(?:NODE_OPTIONS|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|PROMPT_COMMAND)$/i.test(key)));
}

function openJournal(directory: string): HardenedSqliteDatabase {
  return new HardenedSqliteDatabase({
    filename: join(directory, "operations.sqlite"), applicationId: APPLICATION_ID, storeName: "leo-work-commands",
    migrations: [{ version: 1, name: "work-command-journal", apply(database) {
      database.exec(`CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        recovery_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(recovery_acknowledged IN (0, 1))
      ) STRICT`);
    } }],
  });
}

async function prepareJournal(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new Error("Work command state directory must be absolute");
  if (process.platform !== "win32") {
    for (let current = resolve(directory); ; current = dirname(current)) {
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Work command state cannot use symlink ancestors");
        if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) throw new Error("Work command state has a writable shared ancestor");
        if (current === resolve(directory) && ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.())) throw new Error("Work command state must already be private and owned by this user");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (dirname(current) === current) break;
    }
  }
  await privateDirectory(directory);
  for (const suffix of ["", "-wal", "-shm", "-journal", ".lock.sqlite", ".lock.sqlite.owner.json"]) {
    const filename = join(directory, `operations.sqlite${suffix}`);
    await verifyPrivateTarget(filename);
    if (process.platform !== "win32") {
      try {
        const info = await lstat(filename);
        if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("Work command journal files must already be private and owned by this user");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}

function parseRecord(row: Record<string, unknown> | undefined): WorkCommandRecord | null {
  return row ? workCommandRecordSchema.parse(JSON.parse(String(row.record_json))) : null;
}

function payloadHash(request: WorkCommandRequest): string {
  return createHash("sha256").update(JSON.stringify([request.cwd, request.command, request.timeoutMs])).digest("hex");
}

function isWithin(root: string, candidate: string, platform: "windows" | "wsl"): boolean {
  const path = platform === "windows" ? win32 : { relative, sep, isAbsolute };
  const inside = path.relative(platform === "windows" ? root.toLowerCase() : root, platform === "windows" ? candidate.toLowerCase() : candidate);
  return inside === "" || (inside !== ".." && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside));
}


interface ActiveCommand {
  record: WorkCommandRecord;
  child: ChildProcess | null;
  done: Promise<void>;
  resolveDone: () => void;
  timeout: ReturnType<typeof setTimeout> | null;
  flush: ReturnType<typeof setTimeout> | null;
  stop: "cancelled" | "timedOut" | null;
  stopping: Promise<void> | null;
  closed: boolean;
  finishing: boolean;
  persistFailed: boolean;
  commandFile: string | null;
}

/** Reconciliation is local-only and requires the service's single writer to be stopped. */
export async function acknowledgeWorkCommandRecovery(stateDirectory: string, operationId: string): Promise<void> {
  workCommandIdSchema.parse({ operationId });
  await prepareJournal(stateDirectory);
  const store = openJournal(stateDirectory);
  try {
    const record = parseRecord(store.database.prepare("SELECT record_json FROM operations WHERE operation_id = ?").get(operationId));
    if (!record || record.state !== "outcomeUnknown") throw new Error("Only an interrupted command can be acknowledged after local process inspection");
    store.database.prepare("UPDATE operations SET recovery_acknowledged = 1 WHERE operation_id = ?").run(operationId);
  } finally { store.close(); }
}

export async function createWorkCommandExecutor(options: WorkCommandExecutorOptions): Promise<WorkCommandExecutor> {
  if (options.platform === "windows" ? process.platform !== "win32" : process.platform !== "linux") throw new Error("Work command platform does not match this OS");
  if (!options.unrestrictedPaths && options.allowedRoots.length === 0) throw new Error("Work command execution requires approved workspace roots");
  const roots = await Promise.all((options.unrestrictedPaths ? [] : options.allowedRoots).map(async root => {
    if (!isAbsolute(root) || !(await stat(root)).isDirectory()) throw new Error("Work command workspace roots must be existing absolute directories");
    return realpath(root);
  }));
  await prepareJournal(options.stateDirectory);
  const store = openJournal(options.stateDirectory);
  const database = store.database;
  const environment = workCommandEnvironment(options.environment ?? process.env);
  let active: ActiveCommand | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let admission = Promise.resolve();
  const save = (record: WorkCommandRecord) => {
    database.prepare("UPDATE operations SET record_json = ? WHERE operation_id = ?").run(JSON.stringify(record), record.operationId);
  };
  try {
    database.exec("BEGIN IMMEDIATE");
    for (const row of database.prepare("SELECT record_json FROM operations WHERE json_extract(record_json, '$.state') = 'running'").all()) {
      const record = parseRecord(row)!;
      save({ ...record, state: "outcomeUnknown", finishedAt: new Date().toISOString() });
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* Preserve startup failure. */ }
    store.close();
    throw error;
  }
  let recoveryRequired = Boolean(database.prepare("SELECT 1 FROM operations WHERE json_extract(record_json, '$.state') = 'outcomeUnknown' AND recovery_acknowledged = 0 LIMIT 1").get());
  const snapshot = (record: WorkCommandRecord) => ({ ...record });
  const getStored = (operationId: string) => parseRecord(database.prepare("SELECT record_json FROM operations WHERE operation_id = ?").get(operationId));

  const safeSave = (job: ActiveCommand): boolean => {
    try { save(job.record); return true; }
    catch {
      job.persistFailed = true;
      recoveryRequired = true;
      return false;
    }
  };
  const flush = (job: ActiveCommand) => {
    if (job.flush) clearTimeout(job.flush);
    job.flush = null;
    safeSave(job);
  };
  const append = (job: ActiveCommand, stream: "stdout" | "stderr", text: string) => {
    const available = MAX_OUTPUT_BYTES - Buffer.byteLength(job.record.stdout) - Buffer.byteLength(job.record.stderr);
    const bytes = Buffer.from(text);
    if (bytes.length > available) job.record.truncated = true;
    // StringDecoder omits an incomplete UTF-8 codepoint at the byte boundary.
    job.record[stream] += bytes.length <= available ? text : new StringDecoder("utf8").write(bytes.subarray(0, available));
    if (!job.flush) job.flush = setTimeout(() => flush(job), OUTPUT_FLUSH_MS);
  };

  const groupAlive = async (pid: number): Promise<boolean> => {
    // WSL is Linux: ignore already-dead zombies awaiting an init reaper. kill(0)
    // alone would keep a finished command busy forever in containers/WSL setups.
    try { process.kill(-pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    const entries = await readdir("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const contents = await readFile(`/proc/${entry}/stat`, "utf8");
        const fields = contents.slice(contents.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return true;
      } catch (error) {
        if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    return false;
  };
  const signalGroup = (pid: number, signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const finish = async (job: ActiveCommand, state: WorkCommandRecord["state"]) => {
    if (job.finishing) return;
    job.finishing = true;
    if (job.timeout) clearTimeout(job.timeout);
    if (job.flush) clearTimeout(job.flush);
    job.timeout = null;
    job.flush = null;
    if (job.commandFile) await unlink(job.commandFile).catch(() => undefined);
    job.record.state = job.persistFailed ? "outcomeUnknown" : state;
    job.record.finishedAt = new Date().toISOString();
    if (!safeSave(job)) job.record.state = "outcomeUnknown";
    if (job.record.state === "outcomeUnknown") {
      recoveryRequired = true;
      job.child?.stdout?.destroy();
      job.child?.stderr?.destroy();
      job.child?.unref();
    }
    if (active === job) active = null;
    job.resolveDone();
  };

  const terminate = (job: ActiveCommand): Promise<void> => {
    if (job.stopping) return job.stopping;
    job.stopping = (async () => {
      const child = job.child;
      if (!child?.pid) return; // Spawn setup observes the pending cancellation before launch.
      let confirmed = false;
      try {
        if (options.platform === "windows") {
          const killer = spawn(win32.join(environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
            env: environment, shell: false, windowsHide: true, stdio: "ignore",
          });
          await Promise.race([new Promise<void>(resolve => {
            killer.once("error", () => resolve()); killer.once("close", () => resolve());
          }), delay(TERMINATE_GRACE_MS).then(() => { killer.kill(); })]);
          const deadline = Date.now() + TERMINATE_DEADLINE_MS;
          while (!job.closed && Date.now() < deadline) await delay(25);
          confirmed = job.closed; // The shell's kernel job closes and kills descendants.
        } else {
          signalGroup(child.pid, "SIGTERM");
          const grace = Date.now() + TERMINATE_GRACE_MS;
          while (Date.now() < grace && await groupAlive(child.pid)) await delay(25);
          if (await groupAlive(child.pid)) signalGroup(child.pid, "SIGKILL");
          const deadline = Date.now() + TERMINATE_DEADLINE_MS;
          while (Date.now() < deadline && (!job.closed || await groupAlive(child.pid))) await delay(25);
          confirmed = job.closed && !await groupAlive(child.pid);
        }
      } catch { confirmed = false; }
      await finish(job, confirmed ? (job.stop ?? "completed") : "outcomeUnknown");
    })();
    return job.stopping;
  };

  const launch = async (job: ActiveCommand, cwd: string) => {
    try {
      let file = "/bin/bash";
      let args = ["--noprofile", "--norc", "-c", job.record.command];
      if (options.platform === "windows") {
        job.commandFile = join(options.stateDirectory, `${job.record.operationId}.command`);
        await writePrivateFile(job.commandFile, job.record.command);
        ({ file, args } = windowsWorkCommandInvocation(job.commandFile, environment));
      }
      if (job.stop || closing) { await finish(job, job.stop ?? "cancelled"); return; }
      const child = spawn(file, args, {
        cwd, env: environment, shell: false, detached: options.platform === "wsl", windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.child = child;
      child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (text: string) => append(job, "stdout", text));
      child.stderr!.on("data", (text: string) => append(job, "stderr", text));
      child.once("error", () => {
        // Do not persist raw spawn errors; they may include environment/path internals.
        if (child.pid) { job.persistFailed = true; void terminate(job); }
        else { void finish(job, "failed"); }
      });
      child.once("exit", (code, signal) => {
        job.record.exitCode = code; job.record.signal = signal;
        // A background child may retain pipes after its shell exits. Reap the
        // owned group now, instead of reporting success while commands survive.
        if (options.platform === "wsl") void terminate(job);
      });
      child.once("close", (code, signal) => {
        job.closed = true; job.record.exitCode = code; job.record.signal = signal;
        if (options.platform === "windows" && !job.stopping) void finish(job, job.stop ?? "completed");
      });
      job.timeout = setTimeout(() => { job.stop ??= "timedOut"; void terminate(job); }, job.record.timeoutMs);
    } catch { await finish(job, "failed"); }
  };

  const executor: WorkCommandExecutor = {
    submit(raw) {
      // Serialize admission only, never queue command execution. The DB commit
      // precedes spawn and even concurrent duplicate requests share one receipt.
      const result = admission.then(async () => {
        if (closing) throw new WorkCommandError("CLOSED", "Work command service is closing");
        const request = workCommandRequestSchema.parse(raw);
        if (Buffer.byteLength(request.command) > MAX_COMMAND_BYTES) throw new Error("Command exceeds the 16 KiB limit");
        const hash = payloadHash(request);
        const existing = active?.record.operationId === request.operationId ? active.record : getStored(request.operationId);
        if (existing) {
          if (existing.payloadHash !== hash) throw new WorkCommandError("REQUEST_CONFLICT", "Operation ID was already used with different command input");
          return snapshot(existing);
        }
        if (recoveryRequired) throw new WorkCommandError("RECOVERY_REQUIRED", "An interrupted command requires local process inspection and recovery acknowledgement before another command can run");
        if (active) throw new WorkCommandError("BUSY", "A work command is already running on this host; no command was queued");
        if (Number(database.prepare("SELECT count(*) AS count FROM operations").get()!.count) >= MAX_JOURNAL_OPERATIONS) throw new WorkCommandError("JOURNAL_FULL", "Work command journal is full; retained operation IDs cannot be recycled");
        let cwd: string;
        try {
          if (!isAbsolute(request.cwd) || !(await stat(request.cwd)).isDirectory()) throw new Error();
          cwd = await realpath(request.cwd);
          if (!options.unrestrictedPaths && !roots.some(root => isWithin(root, cwd, options.platform))) throw new Error();
        } catch { throw new WorkCommandError("INVALID_CWD", options.unrestrictedPaths ? "Command cwd must be an existing absolute directory" : "Command cwd must be an existing directory within an approved workspace root"); }
        if (closing) throw new WorkCommandError("CLOSED", "Work command service is closing");
        const record: WorkCommandRecord = {
          ...request, payloadHash: hash, state: "running", stdout: "", stderr: "", truncated: false,
          exitCode: null, signal: null, createdAt: new Date().toISOString(), finishedAt: null,
        };
        database.prepare("INSERT INTO operations(operation_id, record_json) VALUES (?, ?)").run(request.operationId, JSON.stringify(record));
        let resolveDone!: () => void;
        const job: ActiveCommand = {
          record, child: null, done: new Promise<void>(resolve => { resolveDone = resolve; }), resolveDone,
          timeout: null, flush: null, stop: null, stopping: null, closed: false, finishing: false, persistFailed: false, commandFile: null,
        };
        active = job;
        void launch(job, cwd);
        return snapshot(record);
      });
      admission = result.then(() => undefined, () => undefined);
      return result;
    },
    async get(operationId) {
      workCommandIdSchema.parse({ operationId });
      if (closePromise) throw new WorkCommandError("CLOSED", "Work command service is closed");
      return active?.record.operationId === operationId ? snapshot(active.record) : getStored(operationId);
    },
    async cancel(operationId) {
      workCommandIdSchema.parse({ operationId });
      if (closing) throw new WorkCommandError("CLOSED", "Work command service is closing");
      await admission;
      if (active?.record.operationId !== operationId) return getStored(operationId);
      const job = active;
      job.stop ??= "cancelled";
      if (job.child) void terminate(job);
      await job.done;
      return snapshot(job.record);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await admission;
        if (active) {
          const job = active;
          job.stop ??= "cancelled";
          if (job.child) void terminate(job);
          await job.done;
        }
        store.close();
      })();
      return closePromise;
    },
  };
  return executor;
}
