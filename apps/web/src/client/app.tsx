import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Tabs from "@radix-ui/react-tabs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ChevronDown,
  CircleDot,
  GitBranch,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Server,
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
import { readSessionCatalog } from "./session-catalog.js";
import { SpawnDialog } from "./spawn-dialog.js";
import { terminalSideChannelCapability } from "./terminal-state.js";
import { Badge, Button, IconButton, Input, classes } from "./ui.js";
import { WorkspaceShell, useViewportMode, type PaneActions } from "./workspace-shell.js";
import { navigateMobile, useDismissOnBack, useMobileRoute } from "./mobile-navigation.js";
import { MobileSettings } from "./mobile-settings.js";
import { flushDrafts } from "./session-drafts.js";
import { useMobileState, toggleWatched, signOutMobile } from "./mobile-api.js";

export function App() {
  return <ApiProvider connectionKey={0}><Dashboard /></ApiProvider>;
}

function Dashboard() {
  const { client, connectionKey } = useApi();
  const queryClient = useQueryClient();
  const route = useMobileRoute();
  const viewport = useViewportMode();
  const mobile = viewport === "mobile";
  const mobileState = useMobileState();
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState("");
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [spawnOpen, setSpawnOpen] = useState(false);
  useDismissOnBack(spawnOpen, () => setSpawnOpen(false));
  const [selectedId, setSelectedId] = useState<SessionId | null>(() => route.page === "session" ? route.sessionId : null);
  const [search, setSearch] = useState("");
  const [retained, setRetained] = useState<RetainedSession[]>([]);
  const deferredSearch = useDeferredValue(search);
  useEffect(() => { if (route.page === "session") setSelectedId(route.sessionId); }, [route.page, route.page === "session" ? route.sessionId : null]);
  useEffect(() => {
    const refreshVisible = () => {
      setOnline(navigator.onLine);
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      void queryClient.invalidateQueries({ queryKey: ["access-login"] });
      void queryClient.invalidateQueries({ queryKey: ["authentication-method"] });
      void invalidateFleet(queryClient);
      // Existing watch clients reconnect and reconcile native cursors. Keep the
      // API binding/transcript mounted and never replay uncertain mutations.
    };
    const networkChanged = () => { setOnline(navigator.onLine); refreshVisible(); };
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("online", networkChanged);
    window.addEventListener("offline", networkChanged);
    return () => {
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("online", networkChanged);
      window.removeEventListener("offline", networkChanged);
    };
  }, [queryClient]);

  const description = useQuery({
    queryKey: ["system", connectionKey],
    enabled: true,
    retry: false,
    refetchInterval: 10_000,
    queryFn: () => client.system.describe.query(),
  });
  const connected = description.isSuccess && online;
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
    queryFn: ({ signal }) => readSessionCatalog((input) => client.sessions.search.query(input, { signal }), signal),
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
            void queryClient.invalidateQueries({ queryKey: ["session-link"] });
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

  const directSession = useQuery({
    queryKey: ["session-link", connectionKey, selectedId],
    enabled: connected && selectedId !== null && !(sessions.data?.sessions.some((session) => session.sessionId === selectedId)),
    queryFn: ({ signal }) => client.sessions.get.query(selectedId!, { signal }),
    retry: false,
    refetchInterval: 10_000,
  });
  const projectionFresh = connected && !sessions.isError && !sources.isError && access.data !== false;
  const mayRemoveAbsent = sessions.data?.complete === true && sessions.dataUpdatedAt >= sources.dataUpdatedAt;
  const rows = useMemo(() => retainSessionRows(retained, sessions.data?.sessions ?? [], sources.data ?? [], projectionFresh, mayRemoveAbsent),
    [retained, sessions.data, sources.data, projectionFresh, mayRemoveAbsent]);
  useEffect(() => {
    setRetained((previous) => retainSessionRows(previous, sessions.data?.sessions ?? [], sources.data ?? [], projectionFresh, mayRemoveAbsent));
  }, [sessions.data, sources.data, projectionFresh, mayRemoveAbsent]);

  useEffect(() => {
    if (selectedId || mobile || route.page === "settings") return;
    const preferred = rows.find((row) => !row.stale && row.session.availability === "active") ?? rows[0];
    if (preferred) {
      setSelectedId(preferred.session.sessionId);
      navigateMobile({ page: "session", sessionId: preferred.session.sessionId }, true);
    }
  }, [selectedId, rows, mobile, route.page]);

  const selectedRow = rows.find((row) => row.session.sessionId === selectedId);
  const selected = selectedRow?.session ?? (directSession.data?.sessionId === selectedId ? directSession.data : null);
  const selectedStale = (selectedRow?.stale ?? false) || !projectionFresh;
  const watchedIds = mobileState.data?.watchedSessionIds ?? [];
  const filteredRows = useMemo(() => {
    const needle = deferredSearch.trim().toLocaleLowerCase();
    return [...rows]
      .filter(({ session }) => (!needle || sessionSearchText(session).includes(needle)) && (!mobile || matchesAgentFilter(session, filter, watchedIds)))
      .sort((left, right) => Number(left.stale) - Number(right.stale) || sessionRank(left.session) - sessionRank(right.session) || right.session.updatedAt.localeCompare(left.session.updatedAt));
  }, [deferredSearch, rows, mobile, filter, watchedIds]);

  const globalStatus = description.isPending ? "connecting" : connected ? "connected" : "connection failed";

  function refresh(): void {
    void invalidateFleet(queryClient);
  }

  function selectSession(sessionId: SessionId): void {
    setSelectedId(sessionId);
    navigateMobile({ page: "session", sessionId });
  }

  function spawned(sessionId: SessionId): void {
    selectSession(sessionId);
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }

  async function watchSelected(): Promise<void> {
    if (!selected || watchBusy) return;
    setWatchBusy(true);
    setWatchError("");
    try {
      await toggleWatched(selected.sessionId, !watchedIds.includes(selected.sessionId));
      await queryClient.invalidateQueries({ queryKey: ["mobile-state"] });
    } catch (error) { setWatchError(errorMessage(error)); }
    finally { setWatchBusy(false); }
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
      {(!mobile || route.page === "agents") && route.page !== "settings" ? <AppHeader
        connected={hasConnected}
        globalStatus={globalStatus}
        onRefresh={refresh}
        onSettings={() => navigateMobile({ page: "settings" })}
        mobile={mobile}
      /> : null}

      {access.data === false ? (
        <div className="shrink-0 border-b border-[var(--border-subtle)] px-4 py-2 text-sm text-[var(--status-waiting)]" role="status">
          Your sign-in expired. Your draft is still here. {" "}
          <ReauthenticateLink />
        </div>
      ) : null}

      {hasConnected && (!online || !connected) && access.data !== false ? <p className="shrink-0 border-b border-[var(--border-subtle)] px-3 py-1.5 text-xs text-[var(--status-waiting)]" role="status" data-testid="workspace-offline">{!online ? "Offline. Your draft is saved on this device." : "Reconnecting to your workspace…"}</p> : null}
      {watchError ? <p role="alert" className="shrink-0 px-3 py-1 text-xs text-[var(--status-error)]">{watchError}</p> : null}
      {route.page === "settings" ? <MobileSettings onClose={() => { if (typeof history.state?.leoPreviousHash === "string") history.back(); else navigateMobile({ page: "agents" }, true); }} /> : null}
      <div className={classes("min-h-0 flex-1 flex-col", route.page === "settings" ? "hidden" : "flex")}>
      {!hasConnected ? (
        <ConnectionPanel
          onConnect={() => { void description.refetch(); }}
          status={globalStatus}
          pending={description.isPending}
          error={description.isError ? errorMessage(description.error) : null}
        />
      ) : (
        <WorkspaceShell
          selectedLabel={selected ? sessionTitle(selected) : "Opening agent…"}
          mobilePage={route.page === "session" ? "session" : "agents"}
          selectedStatus={selected ? `${selected.harness} · ${selectedStale ? "Offline" : sessionStatus(selected, false)}` : "Connecting"}
          watched={selected ? watchedIds.includes(selected.sessionId) : false}
          watchBusy={watchBusy}
          onToggleWatched={selected && mobileState.isSuccess ? () => void watchSelected() : undefined}
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
              listNotice={sessions.isError ? "Couldn’t refresh the agent list. Retrying…" : sessions.data?.complete === false ? "Showing part of the agent list (up to 500 agents)." : null}
              onSelect={selectSession}
              mobile={mobile}
              filter={filter}
              onFilter={setFilter}
            />
          )}
          center={<div className="flex h-full min-h-0 flex-col">
            {selectedRow?.stale ? <p className="shrink-0 border-b border-[var(--border-subtle)] px-4 py-2 text-xs text-[var(--status-waiting)]" role="status" data-testid="stale-session-notice">Host offline. Your conversation and draft are still here.</p> : null}
            {selectedId && !selected ? <div className="grid min-h-0 flex-1 place-items-center p-5 text-sm text-[var(--text-secondary)]" role="status">{directSession.isError || directSession.isSuccess ? "This agent is unavailable. Return to Agents to choose another." : "Opening agent…"}</div> : null}
            {!selectedId || selected ? <SessionConsole session={selected} terminalCapability={terminalCapability} readOnly={selectedStale} onNewSession={() => setSpawnOpen(true)} /> : null}
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

      </div>
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

function AppHeader({ connected, globalStatus, onRefresh, onSettings, mobile }: {
  readonly connected: boolean;
  readonly globalStatus: string;
  readonly onRefresh: () => void;
  readonly onSettings: () => void;
  readonly mobile: boolean;
}) {
  return (
    <header className="z-30 flex h-13 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3 sm:px-4 [@media(max-height:500px)]:h-11">
      <div className="mr-auto flex min-w-0 items-center gap-2.5">
        <div className="min-w-0">
          <h1 className="whitespace-nowrap text-base font-semibold tracking-tight">leo<span className="ml-2 font-normal text-[var(--text-muted)]">/ agents</span></h1>
        </div>
      </div>

      {connected ? (
        <>
          <ConnectionMenu status={globalStatus} />
          {!mobile ? <IconButton
            icon={RefreshCw}
            label="Refresh workspace" data-testid="refresh-workspace"
            tone="ghost"
            onClick={onRefresh}
          /> : null}
          <IconButton icon={Settings} label="App settings" tone="ghost" onClick={onSettings} data-testid="mobile-settings-button" />
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
  const [signOutError, setSignOutError] = useState("");
  const authentication = useQuery({
    queryKey: ["authentication-method"], retry: false, staleTime: 60_000,
    queryFn: async () => {
      const response = await fetch("/auth/session", { redirect: "manual", cache: "no-store" });
      if (!response.ok) throw new Error("Account information is unavailable");
      return await response.json() as { method: "cloudflare" | "tailscale" };
    },
  });
  const method = authentication.data?.method;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Account and connection" data-testid="connection-menu-button"
          className="inline-flex min-h-9 items-center gap-2 rounded-md px-2.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-base)]">
          <span className={classes("size-1.5 rounded-full", status === "connected" ? "bg-[var(--status-live)]" : "bg-[var(--status-waiting)]")} aria-hidden="true" />
          <span data-testid="global-status">{status}</span><ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={8} align="end" className="z-50 w-64 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] p-4 text-sm text-[var(--text-primary)]">
          <p>{method === "tailscale" ? "Connected through Tailscale" : method === "cloudflare" ? "Signed in with Cloudflare Access" : "Authenticated connection"}</p>
          {method === "tailscale" ? <p className="mt-2 text-xs text-[var(--text-secondary)]">Access follows your Tailscale account.</p> : null}
          {signOutError ? <p role="alert" className="mt-2 text-xs text-[var(--status-error)]">{signOutError}</p> : null}
          {method === "cloudflare" ? <a className="mt-3 block text-[var(--accent)] underline" href="/cdn-cgi/access/logout" onClick={(event) => { event.preventDefault(); void signOutMobile().catch((error: unknown) => setSignOutError(errorMessage(error))); }}>Sign out</a> : null}
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
        <h2 className="text-base font-semibold">{pending ? "Opening your workspace…" : "Workspace unavailable"}</h2>
        <p className="text-sm text-[var(--text-secondary)]">{pending ? "Connecting to your hosts." : "Retry the connection, or sign in again if your login has expired."}</p>
        {error ? <p className="text-sm text-[var(--status-error)]" role="alert">{error}</p> : null}
        <div className="flex gap-3">
          <Button icon={RefreshCw} onClick={onConnect} disabled={pending} data-testid="connect-button">Retry connection</Button>
          {!pending ? <ReauthenticateLink /> : null}
        </div>
        <p className="text-xs text-[var(--text-muted)]" data-testid="connection-panel-status">{status}</p>
      </div>
    </main>
  );
}

function FleetPane({ actions, search, onSearch, rows, selectedId, runtimeNodes, connected, loading, listNotice, onSelect, mobile, filter, onFilter }: {
  readonly actions: PaneActions;
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly rows: readonly RetainedSession[];
  readonly selectedId: SessionId | null;
  readonly runtimeNodes: readonly RuntimeNodeDescriptor[];
  readonly connected: boolean;
  readonly loading: boolean;
  readonly listNotice: string | null;
  readonly onSelect: (id: SessionId) => void;
  readonly mobile: boolean;
  readonly filter: AgentFilter;
  readonly onFilter: (filter: AgentFilter) => void;
}) {
  return (
    <aside className="flex h-full min-h-0 flex-col bg-[var(--surface-shell)]">
      {!mobile ? <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3">
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
      </header> : null}
      <div className="shrink-0 border-b border-[var(--border-subtle)] p-2.5">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-[var(--text-muted)]" />
          <Input
            className="h-9 pl-8 text-sm"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Find an agent…"
            aria-label="Search agents"
          />
        </label>
      </div>
      {mobile ? <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] px-2 py-1" role="group" aria-label="Filter agents" data-testid="mobile-agent-filters">
        {([["all", "All"], ["watched", "Watched"], ["needsInput", "Needs input"], ["working", "Working"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => onFilter(value)} className={classes("min-h-11 shrink-0 rounded-md px-3 text-xs", filter === value ? "bg-[var(--surface-raised)] text-[var(--text-primary)]" : "text-[var(--text-muted)]")}>{label}</button>)}
      </div> : null}
      {listNotice ? <p role="status" className="shrink-0 px-3 py-2 text-xs text-[var(--status-waiting)]" data-testid="session-list-notice">{listNotice}</p> : null}
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
            <p className="px-3 py-8 text-center text-xs leading-5 text-[var(--text-muted)]">{filter === "all" ? "No agents here yet." : "No agents match this filter."}</p>
          ) : null}
        </div>
      </div>
      <section className="flex max-h-[38%] min-h-0 shrink-0 flex-col border-t border-[var(--border-subtle)] bg-[var(--surface-shell)]">
        <div className="flex shrink-0 items-baseline justify-between gap-2 px-4 py-2.5">
          <h3 className="text-xs font-semibold text-[var(--text-secondary)]">Hosts</h3>
          <span className="text-xs tabular-nums text-[var(--text-muted)]">{runtimeNodes.filter((node) => node.presence === "online" && node.reachability === "reachable").length} online</span>
        </div>
        <div
          className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-2"
          role="region"
          aria-label={`Hosts, ${runtimeNodes.length} shown`}
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
          <span className="block truncate text-sm font-medium leading-5 text-[var(--text-primary)]" title={title}>{title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-[var(--text-muted)]">
            <span className="shrink-0">{session.harness}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{sessionStatus(session, stale)}</span>
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
          {online ? "Online" : "Offline"}{available.length ? ` · ${available.map((entry) => entry.harness).join(", ")}` : ""}
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
          <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">Details</h2>
        </div>
        {actions.collapse ? (
          <IconButton
            icon={PanelRightClose}
            label="Hide details"
            tone="ghost"
            className="size-8 min-h-8"
            onClick={actions.collapse}
            data-testid="right-pane-toggle"
          />
        ) : actions.close ? (
          <IconButton icon={X} label="Close details" tone="ghost" className="size-8 min-h-8" onClick={actions.close} />
        ) : null}
      </header>
      <Tabs.Root defaultValue="metadata" className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="grid h-10 shrink-0 grid-cols-3 border-b border-[var(--border-subtle)] px-2" aria-label="Agent details">
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
            <InspectorEmpty title="No agent selected" body="Open an agent to see its details." />
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
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Connections</h3>
      <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">How this workspace reaches your hosts.</p>

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
  readonly icon: typeof Server;
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

function InspectorEmpty({ title, body }: {
  readonly title: string;
  readonly body: string;
}) {
  return (
    <div className="grid min-h-52 place-items-center p-6 text-center">
      <div>
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

function sessionStatus(session: SessionRecord, stale: boolean): string {
  if (stale) return "Offline";
  if (session.availability !== "active") return "Stopped";
  return ({ running: "Working", idle: "Ready", waitingForInput: "Needs you", error: "Error", stopped: "Stopped" } as Record<string, string>)[session.runtimeStatus] ?? session.runtimeStatus;
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
    queryClient.invalidateQueries({ queryKey: ["session-link"] }),
    queryClient.invalidateQueries({ queryKey: ["interactions"] }),
    queryClient.invalidateQueries({ queryKey: ["metadata"] }),
  ]);
}

export type AgentFilter = "all" | "watched" | "needsInput" | "working";
export function matchesAgentFilter(session: Pick<SessionRecord, "sessionId" | "runtimeStatus">, filter: AgentFilter, watched: readonly string[]): boolean {
  return filter === "all" || filter === "watched" && watched.includes(session.sessionId) || filter === "needsInput" && (session.runtimeStatus === "waitingForInput" || session.runtimeStatus === "error") || filter === "working" && session.runtimeStatus === "running";
}

function ReauthenticateLink() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return <span>
    <a href={`/${window.location.hash}`} className="inline-flex min-h-11 items-center text-[var(--accent)] underline" aria-disabled={pending} onClick={(event) => {
      event.preventDefault();
      if (pending) return;
      setPending(true);
      setError("");
      void flushDrafts().then(() => { window.location.href = `/${window.location.hash}`; }).catch((error: unknown) => { setError(errorMessage(error)); setPending(false); });
    }}>{pending ? "Saving draft…" : "Sign in again"}</a>
    {error ? <span role="alert" className="ml-2 text-xs text-[var(--status-error)]">{error}</span> : null}
  </span>;
}
