import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { v4 as uuid } from "uuid";
import { MAX_COMMAND_BYTES, workCommandSubmitSchema, type WorkCommandRecord, type WorkCommandSubmit } from "../../../../packages/work-commands/src/contract.js";
import { createWorkCommandsHttpClient, matchingWorkCommand, WorkCommandHttpError } from "../../../../packages/work-commands/src/http-client.js";
import { currentDraftScope } from "./session-drafts.js";
import { documents, readDocument, removeDocument, writeDocument, type LocalDocument } from "./draft-storage.js";
import { useDismissOnBack } from "./mobile-navigation.js";
import { Button, Dialog, Input, Select, Textarea } from "./ui.js";

const SLOT = "work-command:pending";
const HISTORY_PREFIX = "work-command:history:";
type LocalCommand = { input: WorkCommandSubmit | null };
const definiteRejection = new Set(["BUSY", "INVALID_INPUT", "INVALID_CWD", "CWD_NOT_ALLOWED", "JOURNAL_FULL", "RECOVERY_REQUIRED", "FORBIDDEN", "UNAUTHORIZED", "HOST_NOT_CONFIGURED"]);
const terminal = (receipt: WorkCommandRecord | null) => receipt && !["running", "outcomeUnknown"].includes(receipt.state);
const states: Record<WorkCommandRecord["state"], string> = { running: "Running", completed: "Completed", timedOut: "Timed out", cancelled: "Cancelled", failed: "Failed", outcomeUnknown: "Outcome unknown — review the host before running more commands" };

/** A deliberate settings hatch; no conversation or shared router knows about it. */
export function WorkCommandsHatch() {
  const client = useMemo(() => createWorkCommandsHttpClient({ origin: location.origin }), []);
  const hosts = useQuery({ queryKey: ["work-command-hosts"], queryFn: () => client.hosts(), retry: false, refetchInterval: 15_000 });
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<LocalDocument<LocalCommand> | undefined>();
  const [history, setHistory] = useState<LocalDocument<LocalCommand>[]>([]);
  const [historyLimit, setHistoryLimit] = useState(50);
  const [selected, setSelected] = useState(""); const [cwd, setCwd] = useState(""); const [command, setCommand] = useState("");
  const [receipt, setReceipt] = useState<WorkCommandRecord | null>(null), [status, setStatus] = useState("");
  const [checked, setChecked] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const lock = useRef(false), epoch = useRef(0), scope = useRef("");
  const pending = saved?.value.input ?? null;
  const host = hosts.data?.find(entry => entry.sourceId === (pending?.target.sourceId ?? selected));
  const targetChanged = pending && host && host.endpointId !== pending.target.endpointId;
  useDismissOnBack(open, () => setOpen(false));

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const owner = currentDraftScope(), value = await readDocument<LocalCommand>(owner, SLOT);
        if (value?.value.input) workCommandSubmitSchema.parse(value.value.input);
        const history = (await documents<LocalCommand>(owner)).filter(entry => entry.kind === "work-command" && entry.id.startsWith(HISTORY_PREFIX));
        if (live) { scope.current = owner; setSaved(value); setHistory(history); setLoaded(true); }
      } catch { if (live) { setStatus("Local recovery storage is unavailable. Reopen App settings after signing in."); setLoaded(false); } }
    }
    void load(); return () => { live = false; epoch.current++; };
  }, []);

  // Reads can resume after reopening or reloading. Submits only happen in an
  // explicit click handler, after the immutable envelope commits to IndexedDB.
  useEffect(() => {
    if (!open || !pending) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const pollingClient = createWorkCommandsHttpClient({ origin: location.origin, signal: controller.signal });
    async function poll() {
      if (lock.current) { timer = setTimeout(() => void poll(), 500); return; }
      const generation = epoch.current;
      try {
        const value = await pollingClient.get({ target: pending!.target, operationId: pending!.request.operationId });
        if (controller.signal.aborted || generation !== epoch.current) return;
        if (value) { matchingWorkCommand(pending!.request, value); setRejected(false); }
        setReceipt(value); setChecked(true); setStatus(value ? "" : "No host receipt yet. The original command may still have run. Check again before retrying.");
        if (value?.state === "running") timer = setTimeout(() => void poll(), 750);
      } catch (error) { if (!controller.signal.aborted && generation === epoch.current) setStatus(errorMessage(error)); }
    }
    void poll(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [open, pending, pollRevision]);

  async function act(action: "run" | "check" | "retry" | "cancel" | "clear" | "leave" | "forget", archived?: WorkCommandSubmit) {
    if (lock.current || !loaded) return;
    lock.current = true; setBusy(true); setStatus("");
    const generation = ++epoch.current;
    try {
      if (scope.current !== currentDraftScope()) throw new Error("Owner changed");
      if (action === "forget" && archived) {
        if (pending || !window.confirm("Delete this saved command input from this device? Keep its operation ID elsewhere if you still need recovery. The host receipt stays intact; nothing will be cancelled or retried.")) return;
        await removeDocument(scope.current, HISTORY_PREFIX + archived.request.operationId);
        setHistory(current => current.filter(entry => entry.value.input?.request.operationId !== archived.request.operationId));
        return;
      }
      if (archived) {
        if (pending) return;
        const result = await writeDocument(scope.current, SLOT, "work-command", { input: workCommandSubmitSchema.parse(archived) }, saved?.revision ?? 0);
        setSaved(result.document); setReceipt(null); setChecked(false); setRejected(false); return;
      }
      if (action === "clear" || action === "leave") {
        if (!pending || action === "clear" && !terminal(receipt) && !rejected) return;
        if (action === "leave" && !window.confirm("Keep this command's recovery record and open a new command form? The original may still have run. Review the work host before executing more commands. Nothing will be retried or cancelled.")) return;
        const id = HISTORY_PREFIX + pending.request.operationId;
        const existing = await readDocument<LocalCommand>(scope.current, id);
        if (!existing) await writeDocument(scope.current, id, "work-command", { input: pending }, 0);
        else if (JSON.stringify(existing.value.input) !== JSON.stringify(pending)) throw new Error("Saved recovery conflict");
        const result = await writeDocument(scope.current, SLOT, "work-command", { input: null }, saved?.revision ?? 0);
        setHistory((await documents<LocalCommand>(scope.current)).filter(entry => entry.kind === "work-command" && entry.id.startsWith(HISTORY_PREFIX)));
        setSaved(result.document); setReceipt(null); setChecked(false); setRejected(false); setCommand("");
        setStatus(action === "leave" ? "Recovery record kept below. Review the host before running another command." : "Original command kept in Saved command records."); return;
      }
      let input = pending;
      if (action === "retry") setRejected(false);
      if (action === "run") {
        if (pending || !host?.available || !cwd.trim() || !command.trim()) return;
        if (new TextEncoder().encode(command).byteLength > MAX_COMMAND_BYTES) { setStatus("Commands can contain at most 16 KiB."); return; }
        input = workCommandSubmitSchema.parse({ target: { sourceId: host.sourceId, endpointId: host.endpointId }, request: { operationId: uuid(), cwd, command, timeoutMs: 30_000 } });
        const result = await writeDocument(scope.current, SLOT, "work-command", { input }, saved?.revision ?? 0);
        setSaved(result.document); setReceipt(null); setChecked(false); setRejected(false);
      }
      if (!input) return;
      const lookup = { target: input.target, operationId: input.request.operationId };
      let value = action === "run" ? await client.submit(input) : action === "cancel" ? await client.cancel(lookup) : await client.get(lookup);
      if (action === "retry" && !value) value = await client.submit(input);
      if (value) { matchingWorkCommand(input.request, value); setRejected(false); }
      if (generation !== epoch.current) return;
      setReceipt(value); setChecked(true);
      if (value?.state === "running") setPollRevision(value => value + 1);
      setStatus(value ? "" : "No host receipt yet. The original command may still have run. Check again before retrying.");
    } catch (error) {
      if (generation === epoch.current) {
        setStatus(errorMessage(error));
        if ((action === "run" || action === "retry") && error instanceof WorkCommandHttpError && definiteRejection.has(error.code)) setRejected(true);
      }
    }
    finally { lock.current = false; if (generation === epoch.current) setBusy(false); }
  }

  if (!hosts.data?.length && !pending && !history.length) return null;
  return <section className="border-b border-[var(--border-subtle)] py-5" data-testid="work-commands-hatch">
    <h2 className="mb-2 text-sm font-semibold">Experimental work commands</h2>
    <p className="mb-3 text-sm text-[var(--text-secondary)]">A recovery tool for the work laptop. Use <code>leo-agents exec</code> for routine commands.</p>
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild><Button>Open work commands{pending ? " · saved action" : ""}</Button></DialogPrimitive.Trigger>
      <Dialog title="Work laptop command" description="Experimental · one command at a time, with a 30-second limit. Closing this window does not stop the command." testId="work-command-dialog">
        <div className="space-y-4 p-4 sm:p-6">
          <label className="block space-y-1 text-sm"><span>Work host</span><Select aria-label="Work host" value={pending?.target.sourceId ?? selected} disabled={Boolean(pending) || busy} onChange={event => setSelected(event.target.value)}>
            <option value="">Choose a work host</option>
            {pending && !host ? <option value={pending.target.sourceId}>{pending.target.sourceId} · unavailable</option> : null}
            {hosts.data?.map(entry => <option key={entry.sourceId} value={entry.sourceId}>{entry.name} · {entry.platform === "windows" ? "PowerShell" : "Bash"}{entry.available ? "" : " · offline"}</option>)}
          </Select></label>
          <label className="block space-y-1 text-sm"><span>Working directory</span><Input aria-label="Working directory" className="font-mono" value={pending?.request.cwd ?? cwd} disabled={Boolean(pending) || busy} placeholder={host?.platform === "windows" ? "C:\\work\\project" : "/home/me/work/project"} onChange={event => setCwd(event.target.value)} /></label>
          <label className="block space-y-1 text-sm"><span>Command</span><Textarea aria-label="Command" className="min-h-24 font-mono" rows={3} spellCheck={false} maxLength={MAX_COMMAND_BYTES} value={pending?.request.command ?? command} disabled={Boolean(pending) || busy} placeholder="git status --short" onChange={event => setCommand(event.target.value)} /></label>
          {targetChanged ? <p className="text-sm text-[var(--status-error)]" role="alert">This host has a different identity. The saved command stays pinned to its original host.</p> : null}
          <div className="flex flex-wrap gap-2">
            {!pending ? <Button tone="primary" disabled={busy || !loaded || !host?.available || !cwd.trim() || !command.trim()} onClick={() => void act("run")}>Run command</Button> : <>
              <Button disabled={busy} onClick={() => void act("check")}>Check original command</Button>
              {checked && !receipt ? <Button disabled={busy || Boolean(targetChanged) || !host?.available} onClick={() => void act("retry")}>Retry original ID</Button> : null}
              {terminal(receipt) || rejected ? <Button disabled={busy} onClick={() => void act("clear")}>New command</Button> : <>
                <Button disabled={busy || Boolean(targetChanged)} onClick={() => void act("cancel")}>Cancel command</Button>
                {receipt?.state === "outcomeUnknown" || !receipt ? <Button tone="ghost" disabled={busy} onClick={() => void act("leave")}>Save for later</Button> : null}
              </>}
            </>}
          </div>
          <div className="space-y-2 text-sm" role="status" aria-live="polite">
            {receipt ? <p className={receipt.state === "outcomeUnknown" || receipt.state === "failed" || receipt.exitCode && receipt.exitCode !== 0 ? "text-[var(--status-error)]" : "text-[var(--text-secondary)]"}>{states[receipt.state]}{receipt.exitCode !== null ? ` · exit ${receipt.exitCode}` : ""}{receipt.truncated ? " · output truncated at 128 KiB" : ""}</p> : null}
            {status ? <p className="text-[var(--status-waiting)]">{status}</p> : null}
            {rejected ? <p className="text-[var(--status-waiting)]">The host rejected this submission. Use New command to edit its input.</p> : null}
            {pending ? <p className="break-all font-mono text-xs text-[var(--text-muted)]">{pending.request.operationId}</p> : null}
          </div>
          {receipt && (receipt.stdout || receipt.stderr) ? <div tabIndex={0} role="region" aria-label="Command output" className="max-h-72 min-w-0 overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3 font-mono text-xs focus-visible:outline-2 focus-visible:outline-[var(--accent)]" data-testid="work-command-output">
            {receipt.stdout ? <pre className="m-0 whitespace-pre" aria-label="Standard output">{receipt.stdout}</pre> : null}
            {receipt.stderr ? <><p className="mb-1 mt-3 text-[var(--text-secondary)]">Standard error</p><pre className="m-0 whitespace-pre" aria-label="Standard error">{receipt.stderr}</pre></> : null}
          </div> : null}
          {history.length ? <details className="border-t border-[var(--border-subtle)] pt-3">
            <summary className="cursor-pointer py-2 text-sm">Saved command records · {history.length}</summary>
            <p className="mb-2 text-xs text-[var(--text-secondary)]">These keep the original host and operation ID on this device. Opening one only checks its receipt.</p>
            <div className="max-h-52 overflow-y-auto divide-y divide-[var(--border-subtle)]">{history.slice(-historyLimit).reverse().map(entry => entry.value.input ? <div className="flex min-w-0 items-center gap-2 py-2" key={entry.id}>
              <div className="min-w-0 flex-1"><p className="truncate text-sm">{entry.value.input.target.sourceId} · {entry.value.input.request.command}</p><p className="break-all font-mono text-xs text-[var(--text-muted)]">{entry.value.input.request.operationId}</p></div>
              <Button disabled={busy || Boolean(pending)} aria-label={`Open saved command ${entry.value.input.request.operationId}`} onClick={() => void act("check", entry.value.input!)}>Open</Button>
              <Button tone="ghost" disabled={busy || Boolean(pending)} aria-label={`Delete saved command ${entry.value.input.request.operationId}`} onClick={() => void act("forget", entry.value.input!)}>Delete</Button>
            </div> : null)}</div>
            {history.length > historyLimit ? <Button tone="ghost" onClick={() => setHistoryLimit(limit => limit + 50)}>Show older records</Button> : null}
          </details> : null}
        </div>
      </Dialog>
    </DialogPrimitive.Root>
  </section>;
}

function errorMessage(error: unknown): string {
  return error instanceof WorkCommandHttpError ? error.message : "No reliable reply. Your saved command is retained; check the original command before retrying. If saving failed, reopen App settings.";
}
