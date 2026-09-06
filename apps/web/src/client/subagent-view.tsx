import { useId, useState, useSyncExternalStore } from "react";
import { SessionTranscript, subagentLabel, type SubagentThread } from "./session-transcript.js";
import { VirtualTranscript } from "./virtual-transcript.js";

export function SubagentView({ transcript }: { readonly transcript: SessionTranscript }) {
  useSyncExternalStore(transcript.subscribe, transcript.snapshot, transcript.snapshot);
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState("");
  const selectId = useId();
  const threads = transcript.threads;
  const thread = threads.find((candidate) => candidate.id === selected) ?? threads[0];
  const matches = filter ? threads.filter((child) => subagentLabel(child).toLowerCase().includes(filter.toLowerCase())) : threads;
  const choices = matches.slice(0, 100);
  if (thread && !choices.includes(thread)) choices.unshift(thread);
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="subagents-view">
    <div className="shrink-0 border-b border-[var(--border-subtle)] px-4 py-2 text-xs text-[var(--text-secondary)] sm:px-5">
      {thread ? <div className="flex min-w-0 items-center gap-3">
        <label htmlFor={selectId}>Agent</label>
        <select id={selectId} value={thread.id} onChange={(event) => setSelected(event.target.value)} data-testid="subagent-select"
          className="min-h-9 min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-shell)] px-2 text-sm text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
          {choices.map((child) => <option key={child.id} value={child.id}>{subagentLabel(child)}</option>)}
        </select>
        <span className="shrink-0" data-testid="subagent-status">{thread.status === "unknown" ? "Status unavailable" : thread.status === "running" ? "Working" : thread.status === "idle" ? "Idle" : thread.status === "error" ? "Error" : "Interrupted"}</span>
      </div> : null}
      {threads.length > 100 ? <label className="mt-2 flex items-center gap-2">Find an agent
        <input value={filter} onChange={(event) => setFilter(event.target.value)} className="min-h-9 min-w-0 flex-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-shell)] px-2" />
        <span>{Math.min(matches.length, 100)} of {matches.length}</span>
      </label> : null}
      <p className="mt-1.5" data-testid="subagent-history-note">{transcript.hasGap ? "Activity was missed during a connection gap. " : ""}Partial history: only activity received while this session is open is shown. Earlier child history is unavailable here.</p>
    </div>
    {thread ? <ChildTranscript key={thread.id} thread={thread} />
      : <p className="m-auto px-6 text-sm text-[var(--text-secondary)]">Subagents will appear here when this agent delegates work.</p>}
  </div>;
}

function ChildTranscript({ thread }: { readonly thread: SubagentThread }) {
  useSyncExternalStore(thread.store.subscribe, thread.store.snapshot, thread.store.snapshot);
  return thread.store.count ? <VirtualTranscript store={thread.store} loading={false} working={thread.status === "running"} />
    : <p className="m-auto px-6 text-sm text-[var(--text-secondary)]">No transcript received for {subagentLabel(thread)} yet.</p>;
}
