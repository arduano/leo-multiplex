import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Tabs from "@radix-ui/react-tabs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  Cable,
  ChevronDown,
  CircleDot,
  GitBranch,
  Layers3,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { watchAccess } from "@arduano/agent-multiplex-client/browser";
import type {
  RuntimeNodeDescriptor,
  SessionId,
  SessionRecord,
  SourceDiagnostic,
} from "@arduano/agent-multiplex-protocol";

import { ApiProvider, errorMessage, useApi } from "./api.js";
import { MetadataPanel } from "./metadata-panel.js";
import { SessionConsole } from "./session-console.js";
import { retainSessionRows, type RetainedSession } from "./session-retention.js";
import { SpawnDialog } from "./spawn-dialog.js";
import { terminalSideChannelCapability } from "./terminal-state.js";
import { Badge, Button, IconButton, Input, classes } from "./ui.js";
import { WorkspaceShell, type PaneActions } from "./workspace-shell.js";

export function App() {
  return <ApiProvider connectionKey={0}><Dashboard /></ApiProvider>;
}

function Dashboard() {
  const { client, connectionKey } = useApi();
  const queryClient = useQueryClient();
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<SessionId | null>(null);
  const [search, setSearch] = useState("");
  const [retained, setRetained] = useState<RetainedSession[]>([]);
  const deferredSearch = useDeferredValue(search);

  const description = useQuery({
    queryKey: ["system", connectionKey],
    enabled: true,
    retry: false,
    refetchInterval: 10_000,
    queryFn: () => client.system.describe.query(),
  });
  const connected = description.isSuccess;
  const hasConnected = description.data !== undefined;
  const access = useQuery({
    queryKey: ["access-login"], retry: false, refetchInterval: 30_000,
    queryFn: async () => {
      const response = await fetch("/auth/check", { redirect: "manual", cache: "no-store" });
      return response.status === 204;
    },
  });
  const sources = useQuery({
    queryKey: ["sources", connectionKey],
    enabled: connected,
    queryFn: () => client.sources.list.query(),
    refetchInterval: 15_000,
  });
  const controlNodes = useQuery({
    queryKey: ["control-nodes", connectionKey],
    enabled: connected,
    queryFn: () => client.controlNodes.list.query(),
    refetchInterval: 15_000,
  });
  const runtimeNodes = useQuery({
    queryKey: ["runtime-nodes", connectionKey],
    enabled: connected,
    queryFn: () => client.runtimeNodes.list.query(),
    refetchInterval: 10_000,
  });
  const sessions = useQuery({
    queryKey: ["sessions", connectionKey],
    enabled: connected,
    queryFn: () => client.sessions.search.query({
      states: ["running", "stopped"],
      limit: 500,
    }),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!connected) return;
    const watcher = watchAccess(client.sessions.watch, {
      sessions: "all",
      includeNative: false,
      onItem: (item) => {
        if (item.kind === "control") {
          const type = item.change.type;
          if (type.startsWith("session.") || type.startsWith("metadata.")) {
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          }
          if (type.startsWith("runtimeNode.")) {
            void queryClient.invalidateQueries({ queryKey: ["runtime-nodes"] });
          }
          if (type.startsWith("controlNode.") || type.startsWith("authority.")) {
            void queryClient.invalidateQueries({ queryKey: ["control-nodes"] });
          }
        } else if (item.kind === "streamReset") {
          void invalidateFleet(queryClient);
        }
      },
    });
    return () => watcher.stop();
  }, [client, connected, connectionKey, queryClient]);

  const projectionFresh = connected && !sessions.isError && !sources.isError && access.data !== false;
  const rows = useMemo(() => retainSessionRows(retained, sessions.data?.sessions ?? [], sources.data ?? [], projectionFresh, sessions.dataUpdatedAt >= sources.dataUpdatedAt),
    [retained, sessions.data, sources.data, projectionFresh, sessions.dataUpdatedAt, sources.dataUpdatedAt]);
  useEffect(() => {
    setRetained((previous) => retainSessionRows(previous, sessions.data?.sessions ?? [], sources.data ?? [], projectionFresh, sessions.dataUpdatedAt >= sources.dataUpdatedAt));
  }, [sessions.data, sources.data, projectionFresh, sessions.dataUpdatedAt, sources.dataUpdatedAt]);

  useEffect(() => {
    if (selectedId) return;
    const preferred = rows.find((row) => !row.stale && row.session.availability === "active") ?? rows[0];
    if (preferred) setSelectedId(preferred.session.sessionId);
  }, [selectedId, rows]);

  const selectedRow = rows.find((row) => row.session.sessionId === selectedId);
  const selected = selectedRow?.session ?? null;
  const selectedStale = selectedRow?.stale ?? false;
  const filteredRows = useMemo(() => {
    const needle = deferredSearch.trim().toLocaleLowerCase();
    return [...rows]
      .filter(({ session }) => !needle || sessionSearchText(session).includes(needle))
      .sort((left, right) => Number(left.stale) - Number(right.stale) || sessionRank(left.session) - sessionRank(right.session) || right.session.updatedAt.localeCompare(left.session.updatedAt));
  }, [deferredSearch, rows]);

  const globalStatus = description.isPending ? "connecting" : connected ? "connected" : "connection failed";

  function refresh(): void {
    void invalidateFleet(queryClient);
  }

  function spawned(sessionId: SessionId): void {
    setSelectedId(sessionId);
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }

  const selectedRuntime = selected
    ? runtimeNodes.data?.find((node) => node.runtimeNodeId === selected.runtimeNodeId)
    : undefined;
  const terminalCapability = selected
    ? terminalSideChannelCapability(selectedRuntime, selected.harness)
    : undefined;

  return (
    <DialogPrimitive.Root open={spawnOpen} onOpenChange={setSpawnOpen}>
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--surface-canvas)] text-[var(--text-primary)]">
      <AppHeader
        connected={hasConnected}
        globalStatus={globalStatus}
        onRefresh={refresh}
      />

      {connected && access.data === false ? (
        <div className="shrink-0 border-b border-[var(--border-subtle)] px-4 py-2 text-sm text-[var(--status-waiting)]" role="status">
          Your sign-in expired. Your draft is still here. {" "}
          <a href="/" target="_blank" rel="noopener" className="underline">Sign in again in a new tab</a>
        </div>
      ) : null}

      {!hasConnected ? (
        <ConnectionPanel
          onConnect={() => { void description.refetch(); }}
          status={globalStatus}
          pending={description.isPending}
          error={description.isError ? errorMessage(description.error) : null}
        />
      ) : (
        <WorkspaceShell
          selectedLabel={selected ? sessionTitle(selected) : "No agent selected"}
          left={(actions) => (
            <FleetPane
              actions={actions}
              search={search}
              onSearch={setSearch}
              rows={filteredRows}
              selectedId={selectedId}
              runtimeNodes={runtimeNodes.data ?? []}
              connected={connected}
              loading={sessions.isPending}
              onSelect={setSelectedId}
            />
          )}
          center={<div className="flex h-full min-h-0 flex-col">
            {selectedStale ? <p className="shrink-0 border-b border-[var(--border-subtle)] px-4 py-2 text-xs text-[var(--status-waiting)]" role="status" data-testid="stale-session-notice">Host connection unavailable. Showing stale session details; actions resume after reconnecting.</p> : null}
            <SessionConsole session={selected} terminalCapability={terminalCapability} readOnly={selectedStale} />
          </div>}
          inspector={(actions) => (
            <InspectorPane
              actions={actions}
              session={selected}
              readOnly={selectedStale}
              runtime={selectedRuntime}
              sources={sources.data ?? []}
              controls={controlNodes.data?.length ?? 0}
              runtimes={runtimeNodes.data ?? []}
            />
          )}
        />
      )}

      <SpawnDialog
        open={spawnOpen}
        runtimeNodes={projectionFresh ? runtimeNodes.data ?? [] : []}
        onClose={() => setSpawnOpen(false)}
        onSpawned={spawned}
      />
    </div>
    </DialogPrimitive.Root>
  );
}

function AppHeader({ connected, globalStatus, onRefresh }: {
  readonly connected: boolean;
  readonly globalStatus: string;
  readonly onRefresh: () => void;
}) {
  return (
    <header className="z-30 flex h-13 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3 sm:px-4">
      <div className="mr-auto flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-base)] text-[var(--accent)]">
          <Layers3 className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold tracking-tight">Leo Multiplex</h1>
          <p className="hidden text-xs text-[var(--text-muted)] sm:block">Your agents, on your machines</p>
        </div>
      </div>

      {connected ? (
        <>
          <ConnectionMenu status={globalStatus} />
          <IconButton
            icon={RefreshCw}
            label="Refresh gateway projection"
            tone="ghost"
            onClick={onRefresh}
          />
          <DialogPrimitive.Trigger asChild>
            <Button icon={Plus} tone="primary" data-testid="spawn-button">
              <span className="hidden sm:inline">New agent</span>
              <span className="sm:hidden">New</span>
            </Button>
          </DialogPrimitive.Trigger>
        </>
      ) : (
        <Badge tone="neutral" className="shrink-0">
          <CircleDot className={classes("size-3", globalStatus === "connecting" && "animate-pulse")} />
          <span data-testid="global-status">{globalStatus}</span>
        </Badge>
      )}
    </header>
  );
}

function ConnectionMenu({ status }: { readonly status: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Account and connection" data-testid="connection-menu-button"
          className="inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--border-subtle)] px-2.5 text-xs text-[var(--text-secondary)]">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          <span data-testid="global-status">{status}</span><ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={8} align="end" className="z-50 w-64 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] p-4 text-sm text-[var(--text-primary)]">
          <p>Signed in with Cloudflare Access</p>
          <a className="mt-3 block text-[var(--accent)] underline" href="/cdn-cgi/access/logout">Sign out</a>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ConnectionPanel({ onConnect, status, pending, error }: {
  readonly onConnect: () => void;
  readonly status: string;
  readonly pending: boolean;
  readonly error: string | null;
}) {
  return (
    <main className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-4">
      <div className="w-full max-w-md space-y-4">
        <ShieldCheck className="size-6 text-[var(--accent)]" aria-hidden="true" />
        <h2 className="text-base font-semibold">{pending ? "Opening your workspace…" : "Workspace unavailable"}</h2>
        <p className="text-sm text-[var(--text-secondary)]">{pending ? "Connecting to your hosts." : "Retry the connection, or sign in again if your login has expired."}</p>
        {error ? <p className="text-sm text-[var(--status-error)]" role="alert">{error}</p> : null}
        <div className="flex gap-3">
          <Button icon={pending ? RefreshCw : Cable} onClick={onConnect} disabled={pending} data-testid="connect-button">Retry connection</Button>
          {!pending ? <a className="inline-flex min-h-9 items-center text-sm text-[var(--accent)] underline" href="/" target="_blank" rel="noopener">Sign in again</a> : null}
        </div>
        <p className="text-xs text-[var(--text-muted)]" data-testid="connection-panel-status">{status}</p>
      </div>
    </main>
  );
}

function FleetPane({ actions, search, onSearch, rows, selectedId, runtimeNodes, connected, loading, onSelect }: {
  readonly actions: PaneActions;
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly rows: readonly RetainedSession[];
  readonly selectedId: SessionId | null;
  readonly runtimeNodes: readonly RuntimeNodeDescriptor[];
  readonly connected: boolean;
  readonly loading: boolean;
  readonly onSelect: (id: SessionId) => void;
}) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-[var(--surface-shell)]">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Agents</h2>
          <span className="text-xs tabular-nums text-[var(--text-muted)]">{rows.length}</span>
        </div>
        {actions.collapse ? (
          <IconButton
            icon={PanelLeftClose}
            label="Collapse agents pane"
            tone="ghost"
            className="size-8 min-h-8"
            onClick={actions.collapse}
            data-testid="left-pane-toggle"
          />
        ) : actions.close ? (
          <IconButton icon={X} label="Close agents pane" tone="ghost" className="size-8 min-h-8" onClick={actions.close} />
        ) : null}
      </header>
      <div className="shrink-0 border-b border-[var(--border-subtle)] p-2.5">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-[var(--text-muted)]" />
          <Input
            className="h-9 pl-8 text-xs"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search agents, folders, hosts…"
            aria-label="Search agents"
          />
        </label>
      </div>
      <div
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-2"
        role="region"
        aria-label={`Agent sessions, ${rows.length} shown`}
        tabIndex={0}
        data-testid="session-list"
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5">
          {rows.map(({ session, stale }) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              stale={stale}
              selected={session.sessionId === selectedId}
              runtime={runtimeNodes.find((node) => node.runtimeNodeId === session.runtimeNodeId)}
              onSelect={() => {
                onSelect(session.sessionId);
                actions.close?.();
              }}
            />
          ))}
          {connected && !loading && rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs leading-5 text-[var(--text-muted)]">No sessions match this view.</p>
          ) : null}
        </div>
      </div>
      <section className="flex max-h-[38%] min-h-0 shrink-0 flex-col border-t border-[var(--border-subtle)] bg-[var(--surface-shell)]">
        <div className="flex shrink-0 items-baseline justify-between gap-2 px-4 py-2.5">
          <h3 className="text-xs font-semibold text-[var(--text-secondary)]">Fleet</h3>
          <span className="text-xs tabular-nums text-[var(--text-muted)]">{runtimeNodes.length} runtimes</span>
        </div>
        <div
          className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-2"
          role="region"
          aria-label={`Fleet runtimes, ${runtimeNodes.length} shown`}
          tabIndex={0}
          data-testid="fleet-list"
        >
          {runtimeNodes.map((node) => <RuntimeRow node={node} key={node.runtimeNodeId} />)}
        </div>
      </section>
    </aside>
  );
}

function SessionRow({ session, stale, runtime, selected, onSelect }: {
  readonly session: SessionRecord;
  readonly stale: boolean;
  readonly runtime?: RuntimeNodeDescriptor | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const title = sessionTitle(session);
  return (
    <button
      type="button"
      className={classes(
        "h-[72px] min-h-[72px] max-h-[72px] w-full min-w-0 max-w-full overflow-hidden rounded-md border-l-2 px-2.5 py-2 text-left [contain-intrinsic-size:auto_72px] [content-visibility:auto]",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
        selected
          ? "border-l-[var(--accent)] bg-[var(--surface-raised)]"
          : "border-l-transparent hover:bg-[var(--surface-base)]",
      )}
      onClick={onSelect}
      data-testid="session-card"
      data-session-id={session.sessionId}
      data-harness={session.harness}
      data-stale={stale}
      aria-current={selected ? "true" : undefined}
    >
      <span className="flex items-start gap-2.5">
        <span className={classes(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          session.runtimeStatus === "running" ? "bg-[var(--status-live)]" :
            session.runtimeStatus === "waitingForInput" ? "bg-[var(--status-waiting)]" :
              session.runtimeStatus === "error" ? "bg-[var(--status-error)]" : "bg-[var(--text-muted)]",
        )} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-5 text-[var(--text-primary)]" title={title}>{title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-[var(--text-muted)]">
            <span className="shrink-0">{session.harness}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{stale ? "stale" : session.availability}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{session.runtimeStatus}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{runtime?.name ?? shortId(session.runtimeNodeId)}</span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-xs leading-4 text-[var(--text-muted)]">
            {session.cwd ?? "Workspace unavailable"}
          </span>
        </span>
      </span>
    </button>
  );
}

function RuntimeRow({ node }: { readonly node: RuntimeNodeDescriptor }) {
  const available = node.harnesses.filter((entry) => entry.available);
  const online = node.presence === "online" && node.reachability === "reachable";
  return (
    <div
      className="flex h-12 min-h-12 max-h-12 min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md px-2.5 py-2 [contain-intrinsic-size:auto_48px] [content-visibility:auto] hover:bg-[var(--surface-base)]"
      data-testid="runtime-node-card"
      data-runtime-node-id={node.runtimeNodeId}
    >
      <Server className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-[var(--text-secondary)]">{node.name}</p>
        <p className="truncate text-xs text-[var(--text-muted)]">
          {available.map((entry) => entry.harness).join(" · ") || "No harnesses"} · {node.presence} · {node.reachability}
        </p>
      </div>
      <span className={classes("size-1.5 shrink-0 rounded-full", online ? "bg-[var(--status-live)]" : "bg-[var(--status-error)]")} />
    </div>
  );
}

function InspectorPane({ actions, session, readOnly, runtime, sources, controls, runtimes }: {
  readonly actions: PaneActions;
  readonly session: SessionRecord | null;
  readonly readOnly: boolean;
  readonly runtime?: RuntimeNodeDescriptor | undefined;
  readonly sources: readonly SourceDiagnostic[];
  readonly controls: number;
  readonly runtimes: readonly RuntimeNodeDescriptor[];
}) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-[var(--surface-shell)]">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <SlidersHorizontal className="size-3.5 text-[var(--text-muted)]" aria-hidden="true" />
          <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">Inspector</h2>
        </div>
        {actions.collapse ? (
          <IconButton
            icon={PanelRightClose}
            label="Collapse inspector pane"
            tone="ghost"
            className="size-8 min-h-8"
            onClick={actions.collapse}
            data-testid="right-pane-toggle"
          />
        ) : actions.close ? (
          <IconButton icon={X} label="Close inspector pane" tone="ghost" className="size-8 min-h-8" onClick={actions.close} />
        ) : null}
      </header>
      <Tabs.Root defaultValue="metadata" className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="grid h-10 shrink-0 grid-cols-3 border-b border-[var(--border-subtle)] px-2" aria-label="Inspector sections">
          <InspectorTab value="metadata">Metadata</InspectorTab>
          <InspectorTab value="session">Session</InspectorTab>
          <InspectorTab value="activity">Activity</InspectorTab>
        </Tabs.List>
        <Tabs.Content value="metadata" className="min-h-0 flex-1 overflow-y-auto outline-none" data-testid="metadata-tab">
          <MetadataPanel session={session} readOnly={readOnly} />
        </Tabs.Content>
        <Tabs.Content value="session" className="min-h-0 flex-1 overflow-y-auto outline-none" data-testid="session-tab">
          {session ? (
            <SessionDetails session={session} runtime={runtime} />
          ) : (
            <InspectorEmpty icon={Bot} title="No agent selected" body="Choose a session to inspect its binding and workspace." />
          )}
        </Tabs.Content>
        <Tabs.Content
          value="activity"
          forceMount
          className="min-h-0 flex-1 overflow-y-auto outline-none data-[state=inactive]:hidden"
          data-testid="activity-tab"
        >
          <TopologySummary sources={sources} controls={controls} runtimes={runtimes} />
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}

function InspectorTab({ value, children }: { readonly value: string; readonly children: string }) {
  return (
    <Tabs.Trigger
      value={value}
      className="relative px-2 text-xs font-medium text-[var(--text-muted)] outline-none transition-colors hover:text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:bottom-0 data-[state=active]:after:h-px data-[state=active]:after:bg-[var(--accent)]"
      data-testid={`inspector-tab-${value}`}
    >
      {children}
    </Tabs.Trigger>
  );
}

function SessionDetails({ session, runtime }: {
  readonly session: SessionRecord;
  readonly runtime?: RuntimeNodeDescriptor | undefined;
}) {
  const details = [
    ["Title", sessionTitle(session)],
    ["Harness", session.harness],
    ["Runtime", runtime?.name ?? shortId(session.runtimeNodeId)],
    ["Availability", session.availability],
    ["Working tree", session.cwd ?? "unknown"],
    ["Binding", `revision ${session.bindingRevision}`],
    ["Session ID", session.sessionId],
    ["Vendor session", session.vendorSessionId],
  ] as const;
  return (
    <div className="p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Session details</h3>
      <dl className="mt-4 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
        {details.map(([label, value]) => (
          <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 py-2.5 text-xs" key={label}>
            <dt className="text-[var(--text-muted)]">{label}</dt>
            <dd
              className={classes(
                "min-w-0 break-words text-[var(--text-secondary)]",
                ["Working tree", "Session ID", "Vendor session"].includes(label) && "font-mono text-xs",
              )}
              title={value}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TopologySummary({ sources, controls, runtimes }: {
  readonly sources: readonly SourceDiagnostic[];
  readonly controls: number;
  readonly runtimes: readonly RuntimeNodeDescriptor[];
}) {
  const selectedSources = sources.filter((source) => source.state === "selected").length;
  return (
    <div className="p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Gateway projection</h3>
      <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">Observed topology and source-selection state.</p>

      <dl className="mt-4 grid grid-cols-3 divide-x divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] py-3 text-center">
        <Metric icon={GitBranch} value={selectedSources} label="Sources" />
        <Metric icon={Server} value={controls} label="Controls" />
        <Metric icon={Activity} value={runtimes.length} label="Runtimes" />
      </dl>

      <h4 className="mb-1 mt-5 text-xs font-semibold text-[var(--text-secondary)]">Sources</h4>
      <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
        {sources.map((source) => (
          <div
            className="flex items-center justify-between gap-3 py-2.5 text-xs"
            key={source.sourceId}
            data-testid="source-card"
            data-source-id={source.sourceId}
            data-source-state={source.state}
          >
            <span className="min-w-0">
              <span className="block truncate text-[var(--text-secondary)]">{source.displayName}</span>
              <span className="block truncate font-mono text-xs text-[var(--text-muted)]">{shortId(source.sourceId)}</span>
            </span>
            <Badge tone={source.state === "selected" ? "good" : source.state === "suppressed" ? "warn" : "neutral"}>
              {source.state}
            </Badge>
          </div>
        ))}
        {sources.length === 0 ? <p className="py-5 text-center text-xs text-[var(--text-muted)]">No sources reported.</p> : null}
      </div>

      <h4 className="mb-1 mt-5 text-xs font-semibold text-[var(--text-secondary)]">Runtime health</h4>
      <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
        {runtimes.map((runtime) => (
          <div className="flex items-center gap-2 py-2.5 text-xs" key={runtime.runtimeNodeId}>
            <span className={classes(
              "size-1.5 rounded-full",
              runtime.presence === "online" && runtime.reachability === "reachable" ? "bg-[var(--status-live)]" : "bg-[var(--status-error)]",
            )} />
            <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{runtime.name}</span>
            <span className="text-[var(--text-muted)]">{runtime.presence} · {runtime.reachability}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({ icon: Icon, value, label }: {
  readonly icon: typeof Bot;
  readonly value: number;
  readonly label: string;
}) {
  return (
    <div className="px-1">
      <Icon className="mx-auto size-3.5 text-[var(--text-muted)]" aria-hidden="true" />
      <dd className="mt-1 text-base font-semibold tabular-nums text-[var(--text-primary)]">{value}</dd>
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
    </div>
  );
}

function InspectorEmpty({ icon: Icon, title, body }: {
  readonly icon: typeof Bot;
  readonly title: string;
  readonly body: string;
}) {
  return (
    <div className="grid min-h-52 place-items-center p-6 text-center">
      <div>
        <Icon className="mx-auto size-5 text-[var(--text-muted)]" aria-hidden="true" />
        <h3 className="mt-3 text-sm font-medium text-[var(--text-secondary)]">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{body}</p>
      </div>
    </div>
  );
}

function sessionTitle(session: SessionRecord): string {
  const title = session.metadata.values["agent.title"];
  if (typeof title === "string" && title.trim()) return title;
  const summary = record(session.nativeSummary);
  const nativeTitle = summary && (summary.summary ?? summary.title ?? summary.name);
  return typeof nativeTitle === "string" && nativeTitle.trim()
    ? nativeTitle
    : `${session.harness} · ${shortId(session.sessionId)}`;
}

function sessionSearchText(session: SessionRecord): string {
  return [sessionTitle(session), session.harness, session.cwd, session.sessionId, session.runtimeNodeId]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function sessionRank(session: SessionRecord): number {
  if (session.runtimeStatus === "waitingForInput") return 0;
  if (session.runtimeStatus === "running") return 1;
  if (session.availability === "active") return 2;
  return 3;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function invalidateFleet(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["system"] }),
    queryClient.invalidateQueries({ queryKey: ["access-login"] }),
    queryClient.invalidateQueries({ queryKey: ["sources"] }),
    queryClient.invalidateQueries({ queryKey: ["control-nodes"] }),
    queryClient.invalidateQueries({ queryKey: ["runtime-nodes"] }),
    queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    queryClient.invalidateQueries({ queryKey: ["interactions"] }),
    queryClient.invalidateQueries({ queryKey: ["metadata"] }),
  ]);
}
