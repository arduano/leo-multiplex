import { useMutation, useQuery } from "@tanstack/react-query";
import { FolderOpen, LoaderCircle, Plus, Server } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { launchRequest } from "@arduano/agent-multiplex-client/browser";
import type {
  Harness,
  JsonObject,
  LaunchId,
  LaunchRequest,
  LaunchProfileDescriptor,
  LaunchProfileIdentity,
  RuntimeNodeDescriptor,
  SessionId,
} from "@arduano/agent-multiplex-protocol";

import { errorMessage, useApi } from "./api.js";
import { Button, Dialog, Field, Input, Select, classes } from "./ui.js";
import { forgetOperation, listOperations, reconcileOperation, saveOperation } from "./operation-recovery.js";

export function SpawnDialog({
  open,
  runtimeNodes,
  onClose,
  onSpawned,
}: {
  readonly open: boolean;
  readonly runtimeNodes: readonly RuntimeNodeDescriptor[];
  readonly onClose: () => void;
  readonly onSpawned: (sessionId: SessionId) => void;
}) {
  const { client, connectionKey } = useApi();
  const eligible = useMemo(
    () => runtimeNodes.filter((node) =>
      node.presence === "online" &&
      node.reachability === "reachable" &&
      node.harnesses.some((entry) => entry.available),
    ),
    [runtimeNodes],
  );
  const [runtimeId, setRuntimeId] = useState("");
  const [harness, setHarness] = useState<Harness>("codex");
  const [profileId, setProfileId] = useState("");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState("default");
  const [effort, setEffort] = useState("");
  const dispatching = useRef(false);
  const launchAttempt = useRef<Awaited<ReturnType<typeof launchRequest>> | null>(null);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("");
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [pendingLaunch, setPendingLaunch] = useState<{
    readonly launchId: LaunchId;
    readonly sessionId: SessionId;
  } | null>(null);

  useEffect(() => {
    if (!open || launchAttempt.current) return;
    void listOperations().then(operations => {
      const pending = operations.find(operation => operation.kind === "launch");
      if (!pending || launchAttempt.current) return;
      const request = pending.payload as LaunchRequest;
      launchAttempt.current = request;
      setRuntimeId(request.runtimeNodeId); setHarness(request.harness);
      setPendingLaunch({ launchId: request.launchId, sessionId: request.sessionId });
      setStatus("Checking the saved launch before any retry.");
    }).catch(error => setStatus(errorMessage(error))).finally(() => setRecoveryReady(true));
  }, [open]);

  const runtime = eligible.find((node) => node.runtimeNodeId === runtimeId);
  const availableHarnesses = runtime?.harnesses.filter((entry) => entry.available) ?? [];
  const harnessIsAvailable = availableHarnesses.some((entry) => entry.harness === harness);

  useEffect(() => {
    if (!open || launchAttempt.current) return;
    const first = eligible[0];
    if (!first) return;
    setRuntimeId((current) => eligible.some((node) => node.runtimeNodeId === current)
      ? current
      : first.runtimeNodeId);
  }, [eligible, open]);

  useEffect(() => {
    if (launchAttempt.current) return;
    const current = availableHarnesses.find((entry) => entry.harness === harness);
    if (!current && availableHarnesses[0]) setHarness(availableHarnesses[0].harness);
  }, [availableHarnesses, harness]);

  useEffect(() => {
    if (launchAttempt.current) return;
    setCwd(recentWorkdirs(runtime?.runtimeNodeId)[0] ?? "");
  }, [runtime?.runtimeNodeId]);

  const launchProfiles = useQuery({
    queryKey: ["launch-profiles", connectionKey, runtimeId, harness],
    // Runtime and harness selection can settle in separate renders. Avoid
    // sending a transient pair which the selected runtime does not support.
    enabled: open && Boolean(runtime) && harnessIsAvailable,
    queryFn: () => client.launchProfiles.list.query({
      runtimeNodeId: runtime!.runtimeNodeId,
      harness,
    }),
    staleTime: 30_000,
  });
  const availableProfiles = useMemo(
    () => (launchProfiles.data ?? []).filter((profile) =>
      profile.available && profile.harnesses.includes(harness) && profile.providerId === "leo.local" &&
      profile.profileId === (harness === "codex" ? "workspace" : "copilot-workspace")
    ),
    [harness, launchProfiles.data],
  );
  const profile = availableProfiles.find((candidate) =>
    launchProfileKey(candidate) === profileId
  );

  useEffect(() => {
    if (launchAttempt.current) return;
    setProfileId("");
  }, [runtimeId, harness]);

  useEffect(() => {
    if (profile || launchAttempt.current) return;
    setProfileId(availableProfiles[0] ? launchProfileKey(availableProfiles[0]) : "");
  }, [availableProfiles, profile]);

  const models = useQuery({
    queryKey: ["launch-models", connectionKey, runtimeId, harness, profileId],
    // Runtime selection and the harness correction below can settle in
    // separate renders. Do not query the transient, invalid pair in between
    // (for example, `codex` against a Copilot-only runtime).
    enabled: open && Boolean(runtime) && harnessIsAvailable && Boolean(profile),
    queryFn: () => client.launchProfiles.models.query({
      runtimeNodeId: runtime!.runtimeNodeId,
      profile: launchProfileIdentity(profile!),
      harness,
    }),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (launchAttempt.current) return;
    setModel("");
    setMode(harness === "copilot" ? "interactive" : "default");
    setEffort("");
    setStatus("");
  }, [runtimeId, harness, profileId]);


  const launchStatus = useQuery({
    queryKey: ["launch", connectionKey, pendingLaunch?.launchId],
    enabled: open && pendingLaunch !== null,
    queryFn: () => client.launches.get.query(pendingLaunch!.launchId),
    refetchInterval: 750,
  });

  useEffect(() => {
    const record = launchStatus.data;
    if (!pendingLaunch) return;
    if (!record) {
      if (launchStatus.isSuccess) setStatus("The host has not reported this launch yet. Retry the same launch to recover it safely.");
      return;
    }
    if (record.state === "succeeded") {
      rememberWorkdir(runtimeId, cwd.trim());
      void forgetOperation(pendingLaunch.launchId).catch(error => setStatus(errorMessage(error)));
      launchAttempt.current = null;
      onSpawned(pendingLaunch.sessionId);
      setPendingLaunch(null);
      setStatus("Agent started");
      setTitle("");
      onClose();
      return;
    }
    if (record.state === "failed") {
      void forgetOperation(pendingLaunch.launchId).catch(error => setStatus(errorMessage(error)));
      launchAttempt.current = null;
      setPendingLaunch(null);
      setStatus(record.error ?? `Launch ${record.state}`);
      return;
    }
    setStatus(record.statusMessage ?? launchProgressMessage(record.state));
  }, [launchStatus.data, onClose, onSpawned, pendingLaunch]);

  useEffect(() => {
    if (launchStatus.isError && pendingLaunch) {
      setStatus(`Launch status is unavailable. Retry the same launch when the connection returns: ${errorMessage(launchStatus.error)}`);
    }
  }, [launchStatus.error, launchStatus.isError, pendingLaunch]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (launchAttempt.current) {
        const request = launchAttempt.current;
        const operation = await saveOperation("launch", request);
        const receipt = await reconcileOperation(client, operation);
        if (receipt?.state === "succeeded" || receipt?.state === "failed") return { request, record: await client.launches.get.query(request.launchId).then(record => { if (!record) throw new Error("Launch receipt disappeared"); return record; }) };
        return { request, record: await client.launches.create.mutate(request) };
      }
      if (!runtime) throw new Error("Choose an available runtime node");
      if (!profile) throw new Error("Choose an available launch profile");
      const trimmedCwd = cwd.trim();
      if (!trimmedCwd) throw new Error("Working directory is required");
      const input: JsonObject = harness === "codex"
        ? {
            cwd: trimmedCwd,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(mode === "plan" ? { mode: "plan" } : {}),
          }
        : {
            cwd: trimmedCwd,
            ...(model ? { model } : {}),
            mode: mode === "plan" || mode === "autopilot" ? mode : "interactive",
          };
      const request = launchAttempt.current ?? await launchRequest(
        runtime.runtimeNodeId,
        launchProfileIdentity(profile),
        harness,
        input,
        title.trim() ? { "agent.title": title.trim() } : undefined,
      );
      await saveOperation("launch", request);
      launchAttempt.current = request;
      return { request, record: await client.launches.create.mutate(request) };
    },
    onSettled: () => { dispatching.current = false; },
    onSuccess: async ({ request, record }) => {
      if (record.state === "succeeded" || record.state === "failed") await forgetOperation(request.launchId);
      if (record.state === "failed") {
        setPendingLaunch(null);
        launchAttempt.current = null;
        setStatus(record.error ?? `Launch ${record.state}`);
        return;
      }
      if (record.state === "succeeded") {
        setPendingLaunch(null);
        rememberWorkdir(runtimeId, cwd.trim());
        launchAttempt.current = null;
        onSpawned(request.sessionId);
        setStatus("Agent started");
        onClose();
        setTitle("");
        return;
      }
      setPendingLaunch({ launchId: request.launchId, sessionId: request.sessionId });
      setStatus(record.statusMessage ?? launchProgressMessage(record.state));
    },
    onError: (error) => {
      setStatus(launchAttempt.current ? `Launch response was lost. Checking the original launch; your choices are preserved. ${errorMessage(error)}` : errorMessage(error));
      if (launchAttempt.current) setPendingLaunch({ launchId: launchAttempt.current.launchId, sessionId: launchAttempt.current.sessionId });
    },
  });

  function dispatch(): void {
    if (dispatching.current || !recoveryReady) return;
    dispatching.current = true;
    mutation.mutate();
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setStatus("");
    if (!mutation.isPending && !pendingLaunch) dispatch();
  }

  const launchPending = mutation.isPending || pendingLaunch !== null;

  return (
    <Dialog
      title="New agent"
      description={harness === "copilot"
        ? "Choose a folder and start Copilot with the GitHub account signed in on this host."
        : "Choose a folder and start a Codex session. Full access, no approval prompts."}
      testId="spawn-dialog"
    >
      <form className="grid gap-5 p-4 sm:p-6" onSubmit={submit} data-testid="spawn-form">
        {eligible.length === 0 ? (
          <div className="rounded-md border border-[var(--status-waiting)]/30 bg-[var(--surface-raised)] p-3 text-sm text-[var(--status-waiting)]" role="status">
            Your host is offline. Reconnect it to start a session.
          </div>
        ) : null}
        <div className={classes("grid gap-4", availableHarnesses.length > 1 && "sm:grid-cols-2")}>
          <Field label="Host">
            <span className="relative">
              <Server className="pointer-events-none absolute left-3 top-2.5 size-4 text-[var(--text-muted)]" aria-hidden="true" />
              <Select
                className="pl-9"
                disabled={launchPending}
                value={runtimeId}
                onChange={(event) => {
                  const nextRuntimeId = event.target.value;
                  const nextRuntime = eligible.find((node) =>
                    node.runtimeNodeId === nextRuntimeId
                  );
                  const nextHarness = nextRuntime?.harnesses.find((entry) => entry.available)?.harness;
                  setRuntimeId(nextRuntimeId);
                  if (nextHarness) setHarness(nextHarness);
                }}
                data-testid="spawn-runtime-select"
              >
                {eligible.map((node) => <option key={node.runtimeNodeId} value={node.runtimeNodeId}>{node.name} · {node.harnesses.filter(entry => entry.available).map(entry => entry.harness === "copilot" ? "Copilot" : "Codex").join(", ")}</option>)}
              </Select>
            </span>
          </Field>
          {availableHarnesses.length > 1 ? (
            <Field label="Agent">
              <Select disabled={launchPending} value={harness} onChange={event => setHarness(event.target.value as Harness)} data-testid="spawn-harness-select">
                {availableHarnesses.map(entry => <option key={entry.harness} value={entry.harness}>{entry.harness === "copilot" ? "Copilot" : "Codex"}</option>)}
              </Select>
            </Field>
          ) : null}
        </div>
        <Field label="Working directory" hint="an existing folder on this host">
          <span className="relative">
            <FolderOpen className="pointer-events-none absolute left-3 top-2.5 size-4 text-[var(--text-muted)]" aria-hidden="true" />
            <Input
              required
              disabled={launchPending}
              className="pl-9 font-mono text-sm"
              placeholder="Full path to your project folder"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              list="allowed-roots"
              data-testid="spawn-cwd-input"
            />
            <datalist id="allowed-roots">
              {recentWorkdirs(runtimeId).map((root) => <option key={root} value={root} />)}
            </datalist>
          </span>
        </Field>
        <div className={classes("grid gap-4", harness === "codex" ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
          <Field label="Model">
            <Select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={launchPending || models.isPending || models.isError}
              data-testid="spawn-model-select"
            >
              <option value="">Host default</option>
              {models.data?.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name ?? candidate.id}</option>)}
            </Select>
          </Field>
          <Field label="Mode">
            <Select disabled={launchPending} value={mode} onChange={(event) => setMode(event.target.value)} data-testid="spawn-mode-select">
              <option value={harness === "codex" ? "default" : "interactive"}>{harness === "codex" ? "Agent" : "Interactive"}</option>
              <option value="plan">Plan</option>
              {harness === "copilot" ? <option value="autopilot">Autopilot</option> : null}
            </Select>
          </Field>
          {harness === "codex" ? <Field label="Reasoning effort">
            <Select disabled={launchPending} value={effort} onChange={(event) => setEffort(event.target.value)} data-testid="spawn-effort-select">
              <option value="">Host default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
              <option value="max">Max</option>
              <option value="ultra">Ultra</option>
            </Select>
          </Field> : null}
        </div>
        {models.isError ? (
          <p className="text-xs text-[var(--status-error)]" role="alert">
            Models are unavailable. You can still start with your host default.
          </p>
        ) : null}
        {launchProfiles.isError ? (
          <p className="text-xs text-[var(--status-error)]" role="alert">
            This host is not ready to start an agent. Refresh and try again.
          </p>
        ) : null}
        {runtime && harnessIsAvailable && launchProfiles.isSuccess && !availableProfiles.length ? (
          <p className="text-xs text-[var(--status-waiting)]" role="status">
            This host has no available {harness === "copilot" ? "Copilot" : "Codex"} workspace profile. Check its host setup.
          </p>
        ) : null}
        <Field label="Name" hint="optional">
          <Input
            disabled={launchPending}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What are you working on?"
            data-testid="spawn-title-input"
          />
        </Field>
        {status ? <p className="rounded-md border border-[var(--divider)] bg-[var(--surface-raised)] px-3 py-2 text-xs text-[var(--text-secondary)]" role="status" data-testid="spawn-status">{status}</p> : null}
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--divider)] pt-5">
          <Button onClick={onClose}>{launchPending ? "Close" : "Cancel"}</Button>
          {pendingLaunch ? <Button onClick={dispatch} disabled={mutation.isPending} data-testid="spawn-retry">Retry the same launch</Button> : null}
          <Button
            type="submit"
            tone="primary"
            icon={mutation.isPending ? LoaderCircle : Plus}
            disabled={!recoveryReady || !runtime || !profile || !cwd.trim() || launchPending}
            className={launchPending ? "[&_svg]:animate-spin" : undefined}
            data-testid="spawn-submit"
          >
            {launchPending ? "Starting…" : "Start agent"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

function launchProfileKey(
  profile: Pick<LaunchProfileDescriptor, "providerId" | "profileId" | "contractVersion" | "requestSchemaHash">,
): string {
  return `${profile.providerId}\u0000${profile.profileId}\u0000${profile.contractVersion}\u0000${profile.requestSchemaHash}`;
}

function launchProfileIdentity(profile: LaunchProfileDescriptor): LaunchProfileIdentity {
  return {
    providerId: profile.providerId,
    profileId: profile.profileId,
    contractVersion: profile.contractVersion,
    requestSchemaHash: profile.requestSchemaHash,
  };
}

function launchProgressMessage(state: "accepted" | "preparing" | "nativeStarting" | "cleanupPending" | "outcomeUnknown"): string {
  switch (state) {
    case "outcomeUnknown":
      return "Launch outcome is uncertain. Checking the same operation; no replacement will be started.";
    case "accepted":
      return "Launch accepted. Waiting for the runtime to prepare the agent.";
    case "preparing":
      return "Preparing the agent workspace.";
    case "nativeStarting":
      return "Starting the native agent session.";
    case "cleanupPending":
      return "Launch cleanup is still in progress.";
  }
}

function recentWorkdirs(runtimeId?: string): string[] {
  if (!runtimeId) return [];
  try {
    const values: unknown = JSON.parse(localStorage.getItem(`leo.workdirs.${runtimeId}`) ?? "[]");
    return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string").slice(0, 12) : [];
  } catch { return []; }
}
function rememberWorkdir(runtimeId: string, cwd: string) {
  try { localStorage.setItem(`leo.workdirs.${runtimeId}`, JSON.stringify([cwd, ...recentWorkdirs(runtimeId).filter((v) => v !== cwd)].slice(0, 12))); } catch { /* Preferences are optional. */ }
}
