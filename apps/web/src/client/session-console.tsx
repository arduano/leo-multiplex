import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleStop,
  CornerDownRight,
  ImagePlus,
  LoaderCircle,
  MessageSquareText,
  Send,
  TerminalSquare,
  X,
} from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import * as Tabs from "@radix-ui/react-tabs";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { v4 as randomUUID } from "uuid";

import {
  sessionCommand,
  imageMessage,
  imageTarget,
  uploadImage,
  watchAccess,
} from "@arduano/agent-multiplex-client/browser";
import type {
  NativeEvent,
  CommandRecord,
  CommandEnvelope,
  ImageDescriptor,
  ImageMediaType,
  HarnessCommand,
  SessionRecord,
} from "@arduano/agent-multiplex-protocol";

import { appliedSettingsSummary, preferredModel } from "./agent-settings.js";
import { ModelPicker } from "./model-picker.js";
import { resolveSlash, slashSuggestions, type SlashResult, type SettingsSection } from "./slash-commands.js";
import { errorMessage, useApi } from "./api.js";
import { ImageSessionProvider, prepareImageFile, modelImageLimits } from "./image-media.js";
import { pendingInteractionRefetchInterval } from "./interaction-refresh.js";
import { InteractionCards } from "./interactions.js";
import { SessionErrorBanner } from "./session-error.js";
import { sessionErrorState } from "./session-error-state.js";
import {
  advanceNativeHistorySignal,
  NativeHistoryPager,
  sessionBindingIdentity,
  type NativeHistorySignal,
} from "./native-history.js";
import type { TimelineEntry } from "./transcript.js";
import { SessionTranscript } from "./session-transcript.js";
import { SubagentView } from "./subagent-view.js";
import { VirtualTranscript, type TranscriptHandle } from "./virtual-transcript.js";
import { useSessionDraft } from "./session-drafts.js";
import type { TerminalSideChannelCapability } from "./terminal-state.js";
import { Badge, Button, EmptyState, Textarea, classes } from "./ui.js";

const TerminalPanel = lazy(async () => {
  const module = await import("./terminal-panel.js");
  return { default: module.TerminalPanel };
});

interface CommandAction {
  readonly request: HarnessCommand;
  readonly success: string;
  readonly optimistic?: TimelineEntry;
  readonly images?: CommandEnvelope["images"];
  readonly envelope?: CommandEnvelope;
  readonly consumePrompt?: string;
}

export function SessionConsole({ session, terminalCapability, readOnly = false, onNewSession }: {
  readonly session: SessionRecord | null;
  readonly terminalCapability: TerminalSideChannelCapability | null | undefined;
  readonly readOnly?: boolean;
  readonly onNewSession: () => void;
}) {
  const { connectionKey } = useApi();
  const bindingIdentity = session ? sessionBindingIdentity(session) : "no-session";
  return (
    <BoundSessionConsole
      key={`${connectionKey}:${bindingIdentity}`}
      session={session}
      bindingIdentity={bindingIdentity}
      terminalCapability={terminalCapability}
      readOnly={readOnly}
      onNewSession={onNewSession}
    />
  );
}

function BoundSessionConsole({ session, bindingIdentity, terminalCapability, readOnly = false, onNewSession }: {
  readonly session: SessionRecord | null;
  readonly bindingIdentity: string;
  readonly terminalCapability: TerminalSideChannelCapability | null | undefined;
  readonly readOnly?: boolean;
  readonly onNewSession: () => void;
}) {
  const { client, connectionKey } = useApi();
  const queryClient = useQueryClient();
  const [sessionTranscript] = useState(() => new SessionTranscript(session?.vendorSessionId, session?.harness));
  const store = sessionTranscript.root;
  const [errors] = useState(() => sessionErrorState(`${connectionKey}:${bindingIdentity}`));
  const sessionFailure = useSyncExternalStore(errors.subscribe, errors.snapshot, errors.snapshot);
  const [pager] = useState(() => session ? new NativeHistoryPager(client, session) : null);
  const historyRead = useRef<AbortController | null>(null);
  const historyLoaded = useRef(false);
  const reconcilePending = useRef(false);
  const [historyDone, setHistoryDone] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [historyCount, setHistoryCount] = useState(0);
  const transcript = useRef<TranscriptHandle>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [streamState, setStreamState] = useState("stopped");
  const [historyState, setHistoryState] = useState(
    session ? "loading" : "idle",
  );
  const [historyError, setHistoryError] = useState("");
  const [historySignal, setHistorySignal] = useState<NativeHistorySignal | null>(null);
  const [recentEvents, setRecentEvents] = useState<readonly { kind: string; type: string; sequence?: number }[]>([]);
  const { prompt, setPrompt, images: draftImages, setImages: setDraftImages, uncertain, setUncertain, uncertainPrompt, setUncertainPrompt } = useSessionDraft(`${connectionKey}:${bindingIdentity}`);
  const draftsRef = useRef(draftImages);
  draftsRef.current = draftImages;
  const mounted = useRef(true);
  const preparing = useRef(false);
  const dispatching = useRef(false);
  const [preparingImages, setPreparingImages] = useState(false);
  const imagePicker = useRef<HTMLInputElement>(null);
  const imageUpload = useRef<AbortController | null>(null);
  const [uploading, setUploading] = useState(false);
  useEffect(() => { if (readOnly) imageUpload.current?.abort(); }, [readOnly]);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    imageUpload.current?.abort();
  }; }, []);
  const [actionStatus, setActionStatus] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("model");
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const slashMenuId = useId();
  const [workspaceView, setWorkspaceView] = useState<"chat" | "subagents" | "terminal">("chat");
  const historyGeneration = session && historySignal?.bindingIdentity === bindingIdentity
    ? historySignal.generation
    : 0;

  const models = useQuery({
    queryKey: ["models", connectionKey, session?.runtimeNodeId, session?.harness],
    enabled: Boolean(session),
    queryFn: () => client.harness.models.query({
      runtimeNodeId: session!.runtimeNodeId,
      harness: session!.harness,
    }),
    staleTime: 30_000,
  });
  const interactions = useQuery({
    queryKey: ["interactions", connectionKey, bindingIdentity],
    enabled: Boolean(session),
    queryFn: () => client.interactions.list.query({
      sessionId: session!.sessionId,
      pendingOnly: true,
    }),
    // Stream invalidation remains the low-latency path. Poll only the selected
    // session as a recovery net for an observer that missed a control event.
    refetchInterval: pendingInteractionRefetchInterval(session?.sessionId),
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    setRecentEvents([]);
    setHistorySignal(null);
    setHistoryState(
      session ? "loading" : "idle",
    );
    setHistoryError("");
    setStreamState(session ? "connecting" : "stopped");
    setActionStatus("");
    setWorkspaceView("chat");
  }, [bindingIdentity, connectionKey]);

  // Establish the native stream before asking the harness for history. The
  // reducer merges stable native IDs, so an event visible in both cannot be lost.
  useEffect(() => {
    if (!session) return;
    const watchedSessionId = session.sessionId;
    const watchedRuntimeEpoch = session.runtimeEpoch;
    let active = true;
    let frame = 0;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseBackpressure: (() => void) | undefined;
    let queued: NativeEvent[] = [];
    const flush = () => {
      cancelAnimationFrame(frame);
      clearTimeout(flushTimer);
      frame = 0;
      flushTimer = undefined;
      releaseBackpressure?.();
      releaseBackpressure = undefined;
      if (!active) return;
      const events = queued;
      queued = [];
      sessionTranscript.applyEvents(events);
      setRecentEvents((current) => [...current, ...events.slice(-10).map((event) => ({ kind: event.kind, type: event.nativeType, sequence: event.sequence }))].slice(-40));
    };
    const signalHistory = (cause: "lifecycle" | "reconcile") => {
      if (!active) return;
      setHistorySignal((current) => advanceNativeHistorySignal(
        current,
        bindingIdentity,
        historyLoaded.current,
        cause,
      ));
    };
    const watcher = watchAccess(client.sessions.watch, {
      sessions: [watchedSessionId],
      includeNative: true,
      maxPendingItems: 2_048,
      onStateChange: (state) => {
        if (!active) return;
        setStreamState(state.state);
        if (state.state === "failed") setActionStatus(errorMessage(state.error));
      },
      onItem: (item) => {
        if (!active) return;
        if (item.kind === "native" && item.sessionId === watchedSessionId) {
          // A logical session may retain its ID across native runtime epochs.
          // Ignore buffered events belonging to another concrete binding.
          if (watchedRuntimeEpoch == null || item.runtimeEpoch !== watchedRuntimeEpoch) return;
          errors.observe(item, session.vendorSessionId);
          queued.push(item);
          if (!frame) {
            frame = requestAnimationFrame(flush);
            // rAF is suspended in background tabs. Keep our buffer bounded and
            // let watchAccess provide upstream backpressure after 64 events.
            flushTimer = setTimeout(flush, 32);
          }
          // A new thread may initially reject history. Retry at a native
          // lifecycle boundary, without rereading successful history each turn.
          if ((item.harness !== "codex" || (item.payload.json as { threadId?: unknown } | null)?.threadId === session.vendorSessionId) &&
              (item.nativeType === "turn/completed" || item.nativeType === "session.idle")) {
            signalHistory("lifecycle");
          }
          if (queued.length >= 64) return new Promise<void>((resolve) => { releaseBackpressure = resolve; });
          return;
        }
        if (item.kind === "nativeGap" && item.sessionId === watchedSessionId) {
          sessionTranscript.markGap();
          signalHistory("reconcile");
          return;
        }
        if (item.kind === "control") {
          setRecentEvents((current) => [...current, { kind: item.kind, type: item.change.type }].slice(-40));
          const change = item.change;
          if (change.type.startsWith("session.")) {
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          }
          if (change.type === "interaction.changed" && change.interaction.sessionId === watchedSessionId) {
            void queryClient.invalidateQueries({ queryKey: ["interactions"] });
          }
          if (change.type === "metadata.changed" && change.sessionId === watchedSessionId) {
            void queryClient.invalidateQueries({ queryKey: ["metadata"] });
          }
        }
        if (item.kind === "streamReset") {
          sessionTranscript.markGap();
          signalHistory("reconcile");
        }
      },
    });
    return () => {
      active = false;
      watcher.stop();
      cancelAnimationFrame(frame);
      clearTimeout(flushTimer);
      releaseBackpressure?.();
      queued = [];
    };
  }, [bindingIdentity, client, connectionKey, queryClient]);

  // The published item pages omit turn failures. Read native status separately
  // so a failed session cannot look healthy after reload. This is a bounded
  // metadata request, never a full-history read or an agent command.
  useEffect(() => {
    if (session?.harness !== "codex") return;
    const controller = new AbortController();
    const generation = errors.generation;
    const start = setTimeout(() => {
      void client.sessions.readNativeHistory.query({
        sessionId: session.sessionId,
        request: { harness: "codex", includeTurns: false },
      }, { signal: controller.signal }).then((result) => {
        if (controller.signal.aborted) return;
        const payload = result.payload.json as { thread?: { status?: unknown } } | null;
        errors.observeStatus(payload?.thread?.status, generation);
      }).catch(() => { /* History/connection controls own read failures. */ });
    }, 0);
    return () => { clearTimeout(start); controller.abort(); };
  }, [bindingIdentity, client, errors, historyGeneration]);

  const readHistory = useCallback(async (all = false, reconcile = false) => {
    if (!pager) return;
    if (historyRead.current) { if (reconcile) reconcilePending.current = true; return; }
    const controller = new AbortController();
    historyRead.current = controller;
    if (reconcile) pager.reconcile();
    setHistoryState("loading");
    setLoadingAll(all);
    try {
      do {
        const page = await pager.next(controller.signal);
        if (!mounted.current || controller.signal.aborted) return;
        sessionTranscript.appendHistory(page.entries);
        historyLoaded.current = true;
        setHistoryCount(store.historyCount);
        setHistoryDone(page.complete);
        if (!all || page.complete) break;
        // Yield between bounded native pages so input and paints remain usable.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        controller.signal.throwIfAborted();
      } while (!pager.done);
      setHistoryState(pager.done ? "loaded" : "partial");
      setHistoryError("");
    } catch (error) {
      if (!mounted.current) return;
      if (controller.signal.aborted) setHistoryState(pager.done ? "loaded" : "partial");
      else { setHistoryState("failed"); setHistoryError(`History unavailable: ${errorMessage(error)}`); }
    } finally {
      if (historyRead.current === controller) historyRead.current = null;
      if (mounted.current) setLoadingAll(false);
      if (mounted.current && reconcilePending.current && !controller.signal.aborted) {
        reconcilePending.current = false;
        void readHistory(true, true);
      }
    }
  }, [pager, store]);

  useEffect(() => {
    if (!session) return;
    // Catalog summaries are optional and can remain absent for launched
    // sessions with existing messages. Ask the native history API directly.
    // Let the effect commit before issuing a request. StrictMode's setup /
    // cleanup probe otherwise aborts the first read and leaves its replacement
    // waiting behind that same in-flight promise.
    // The published API pages oldest first. Keep following bounded pages so
    // opening a session reaches its actual latest messages without another click.
    const start = setTimeout(() => { void readHistory(true, historyGeneration > 0); }, 0);
    return () => { clearTimeout(start); };
  }, [historyGeneration, bindingIdentity, readHistory]);
  useEffect(() => () => { historyRead.current?.abort(); }, []);

  const mutation = useMutation({
    retry: false,
    onSettled: () => { dispatching.current = false; },
    mutationFn: async (action: CommandAction) => {
      if (!session) throw new Error("Select a session first");
      if (readOnly) throw new Error("Reconnect the host before changing this session");
      const envelope = action.envelope ?? await sessionCommand(session, action.request, action.images);
      setUncertain(envelope);
      setUncertainPrompt(action.consumePrompt ?? null);
      if (action.optimistic && !action.envelope) {
        store.addLocal({ ...action.optimistic!, id: `local:${envelope.commandId}` });
      }
      const record = await client.sessions.execute.mutate(envelope);
      if (record.state !== "outcomeUnknown" && record.state !== "received" && record.state !== "started") { setUncertain(null); setUncertainPrompt(null); }
      return { action, record };
    },
    onSuccess: async ({ action, record }) => {
      setActionStatus(commandStatus(action.success, record));
      if (record.state === "succeeded" && (action.request.command.type === "send" || action.request.command.type === "steer")) {
        setPrompt("");
        for (const image of draftsRef.current) URL.revokeObjectURL(image.url);
        setDraftImages([]);
      }
      if (record.state === "succeeded" && action.consumePrompt !== undefined) setPrompt(current => current === action.consumePrompt ? "" : current);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      if (record.state === "succeeded" && action.request.command.type === "setModel" && session?.harness === "codex" && settingsOpen) setSettingsSection("effort");
    },
    onError: (error) => setActionStatus(errorMessage(error)),
  });

  function executeAction(action: CommandAction): void {
    if (dispatching.current || readOnly) return;
    dispatching.current = true;
    mutation.mutate(action);
  }

  if (!session) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center">
        <EmptyState
          icon={MessageSquareText}
          title="Choose an agent"
          body="Select an active or resumable session from the left rail, or launch a new one."
        />
      </div>
    );
  }

  const active = !readOnly && session.availability === "active";
  const running = session.runtimeStatus === "running";
  const busy = mutation.isPending || uploading || preparingImages || Boolean(uncertain);
  const suggestions = active && !busy && slashDismissed !== prompt ? slashSuggestions(prompt, session.harness) : [];
  const selectedSlash = Math.min(slashIndex, suggestions.length - 1);
  const composerIntent = resolveSlash(prompt, { harness: session.harness, models: models.data ?? [], model: session.harnessSettings?.model, running });
  const isSlash = composerIntent.kind !== "message";
  const pendingInteractions = interactions.data?.filter((item) => item.state === "pending") ?? [];
  const title = sessionTitle(session);
  const settingsSummary = appliedSettingsSummary(
    session.harness,
    session.harnessSettings,
    models.data ?? [],
  );

  const imageLimits = modelImageLimits(session.harnessSettings?.model
    ? (models.data ?? []).find((model) => model.id === session.harnessSettings?.model)
    : preferredModel(models.data ?? []));

  function dispatch(request: HarnessCommand, success: string, optimistic?: TimelineEntry, consumePrompt?: string): void {
    if (!active || uncertain || uploading || preparing.current || mutation.isPending || dispatching.current) return;
    setActionStatus("Dispatching command once…");
    executeAction({ request, success, ...(optimistic ? { optimistic } : {}), ...(consumePrompt !== undefined ? { consumePrompt } : {}) });
  }

  function openSettings(section: SettingsSection) {
    setActionStatus("");
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  function performSlash(intent: Exclude<SlashResult, { kind: "message" }>, consumed: string): void {
    if (!active || busy || dispatching.current) return;
    if (intent.kind === "error") { setActionStatus(intent.message); setSlashDismissed(prompt); return; }
    if (intent.kind === "command") {
      dispatch(intent.request, intent.success, undefined, consumed);
      return;
    }
    setPrompt(current => current === consumed ? "" : current);
    if (intent.kind === "settings") { openSettings(intent.section); return; }
    setActionStatus("");
    if (intent.action === "help") { setPrompt("/"); setSlashDismissed(null); setSlashIndex(0); promptInput.current?.focus(); }
    else if (intent.action === "status") setDiagnosticsOpen(true);
    else if (intent.action === "terminal") setWorkspaceView("terminal");
    else onNewSession();
  }

  function chooseSlash(name: string) {
    const intent = resolveSlash(`/${name}`, { harness: session!.harness, models: models.data ?? [], model: session!.harnessSettings?.model, running });
    if (intent.kind !== "message") performSlash(intent, prompt);
  }

  function changeSetting(text: string) {
    const intent = resolveSlash(text, { harness: session!.harness, models: models.data ?? [], model: session!.harnessSettings?.model, running });
    if (intent.kind === "command") dispatch(intent.request, intent.success);
    else if (intent.kind === "error") setActionStatus(intent.message);
  }

  async function attachImages(files: readonly File[]): Promise<void> {
    if (!active || uploading || mutation.isPending || uncertain || preparing.current) return;
    preparing.current = true;
    setPreparingImages(true);
    try {
      if (imageLimits.support === "unsupported") throw new Error("The applied model does not accept images");
      if (draftsRef.current.length + files.length > imageLimits.count) throw new Error(`Attach at most ${imageLimits.count} images for this model`);
      const prepared = await Promise.all(files.map(prepareImageFile));
      if (!mounted.current) return;
      if (prepared.some((file) => file.size > imageLimits.bytes)) throw new Error(`This model accepts images of at most ${Math.floor(imageLimits.bytes / 1024)} KiB`);
      if (imageLimits.mediaTypes && prepared.some((file) => !imageLimits.mediaTypes!.includes(file.type))) throw new Error("This image type is not supported by the applied model");
      if ([...draftsRef.current.map((item) => item.file), ...prepared].reduce((total, file) => total + file.size, 0) > 50 * 1_024 * 1_024) throw new Error("Image attachments exceed 50 MiB");
      const next = [...draftsRef.current, ...prepared.map((file) => ({ id: randomUUID(), file, url: URL.createObjectURL(file) }))];
      draftsRef.current = next;
      setDraftImages(next);
      setActionStatus("");
    } catch (error) { if (mounted.current) setActionStatus(errorMessage(error)); }
    finally { preparing.current = false; if (mounted.current) setPreparingImages(false); }
  }

  async function send(kind: "send" | "steer"): Promise<void> {
    if (!session || !active || (!prompt.trim() && !draftImages.length) || uploading || imageUpload.current || uncertain || preparing.current || dispatching.current) return;
    const intent = resolveSlash(prompt, { harness: session.harness, models: models.data ?? [], model: session.harnessSettings?.model, running });
    if (intent.kind !== "message") { performSlash(intent, prompt); return; }
    if (draftImages.length && (imageLimits.support === "unsupported" || draftImages.length > imageLimits.count ||
      draftImages.some((image) => image.file.size > imageLimits.bytes || imageLimits.mediaTypes && !imageLimits.mediaTypes.includes(image.file.type)))) {
      setActionStatus("Attachments exceed the applied model's image capabilities");
      return;
    }
    transcript.current?.followLatest();
    const body = intent.text.trim();
    let request: HarnessCommand = session.harness === "codex"
      ? kind === "send"
        ? { harness: "codex", command: { type: "send", input: body } }
        : { harness: "codex", command: { type: "steer", input: body } }
      : kind === "send"
        ? { harness: "copilot", command: { type: "send", prompt: body, mode: "enqueue" } }
        : { harness: "copilot", command: { type: "steer", prompt: body, mode: "immediate" } };
    let images: CommandEnvelope["images"];
    let descriptors: ImageDescriptor[] = [];
    if (draftImages.length) {
      const controller = new AbortController();
      imageUpload.current = controller;
      setUploading(true);
      try {
        const runtime = (await client.runtimeNodes.list.query()).find((item) => item.runtimeNodeId === session.runtimeNodeId);
        if (!runtime) throw new Error("The session runtime is unavailable");
        const target = imageTarget(session, runtime);
        for (const draft of draftImages) {
          controller.signal.throwIfAborted();
          const descriptor = draft.descriptor ?? await uploadImage(client, target, new Uint8Array(await draft.file.arrayBuffer()), draft.file.type as ImageMediaType, {
            imageId: draft.id,
            signal: controller.signal,
            onProgress: (sent, total) => setActionStatus(`Uploading ${draft.file.name} · ${Math.round(sent / total * 100)}%`),
          });
          descriptors.push(descriptor);
          setDraftImages((current) => current.map((item) => item.id === draft.id ? { ...item, descriptor } : item));
        }
        const message = imageMessage(session.harness, kind, body, descriptors);
        request = message.request;
        images = message.images;
      } catch (error) {
        setActionStatus(controller.signal.aborted ? "Upload cancelled; your draft is retained" : errorMessage(error));
        return;
      } finally { if (mounted.current) setUploading(false); imageUpload.current = null; }
      if (!mounted.current) return;
    }
    setActionStatus("Dispatching command once…");
    executeAction({ request, images, success: kind === "send" ? "Message sent" : "Steering message sent", optimistic: {
      id: "local:pending",
      kind: "user",
      title: kind === "send" ? "You" : "You · steer",
      body,
      timestamp: new Date().toISOString(),
      raw: { local: true, kind },
      sequence: 2_000_000_000 + Date.now(),
      pending: true,
      images: descriptors.map((image) => ({ image })),
    } });
  }

  function keyboardSend(event: KeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (suggestions.length) {
      if (event.key === "Escape") { event.preventDefault(); setSlashDismissed(prompt); promptInput.current?.focus(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = (selectedSlash + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
        setSlashIndex(next);
        document.getElementById(`${slashMenuId}-${next}`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "Tab") { event.preventDefault(); setPrompt(`/${suggestions[selectedSlash]!.name} `); setSlashIndex(0); return; }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); chooseSlash(suggestions[selectedSlash]!.name); return; }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!busy && active && (prompt.trim() || draftImages.length)) void send("send");
  }

  return (
    <ImageSessionProvider session={session} readOnly={readOnly}><Tabs.Root
      className="flex min-h-0 flex-1 flex-col"
      value={workspaceView}
      onValueChange={(value) => setWorkspaceView(value as "chat" | "subagents" | "terminal")}
      data-testid="session-console"
    >
      <header className="session-header flex min-h-[72px] flex-col items-stretch justify-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-shell)] px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:px-5 [@media(max-height:500px)]:min-h-12 [@media(max-height:500px)]:py-0">
        <div className="min-w-0 sm:flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-[var(--text-primary)]" title={title}>{title}</h1>
            <Badge tone={session.harness === "codex" ? "brand" : "good"}>{session.harness}</Badge>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[var(--text-secondary)] [@media(max-height:500px)]:hidden">
            <span className="truncate font-mono" title={session.cwd ?? undefined}>{session.cwd ?? "Workspace unavailable"}</span>
            <span className="sr-only" data-testid="selected-session-id">{session.sessionId}</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-xs text-[var(--text-secondary)] sm:justify-end">
          <Tabs.List
            className="inline-flex h-8 items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-base)] p-0.5"
            aria-label="Session workspace view"
            data-testid="session-view-tabs"
          >
            <Tabs.Trigger
              value="chat"
              className="inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 font-medium text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] data-[state=active]:bg-[var(--surface-raised)] data-[state=active]:text-[var(--text-primary)]"
              data-testid="session-chat-tab"
            >
              <MessageSquareText aria-hidden="true" className="size-3.5" />
              Chat
            </Tabs.Trigger>
            {session.harness === "codex" ? <Tabs.Trigger value="subagents"
              className="inline-flex h-7 items-center rounded-[4px] px-2.5 font-medium text-[var(--text-secondary)] outline-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] data-[state=active]:bg-[var(--surface-raised)] data-[state=active]:text-[var(--text-primary)]"
              data-testid="session-subagents-tab">Subagents</Tabs.Trigger> : null}
            <Tabs.Trigger
              value="terminal"
              className="inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 font-medium text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] data-[state=active]:bg-[var(--surface-raised)] data-[state=active]:text-[var(--text-primary)]"
              data-testid="session-terminal-tab"
            >
              <TerminalSquare aria-hidden="true" className="size-3.5" />
              Terminal
            </Tabs.Trigger>
          </Tabs.List>
          <StatusLabel tone={sessionFailure ? "bad" : runtimeTone(session.runtimeStatus)}>{sessionFailure ? "Error reported" : humanizeStatus(session.runtimeStatus)}</StatusLabel>
          <Popover.Root open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen}>
            <Popover.Trigger asChild><button className="min-h-9 text-xs text-[var(--text-secondary)]" title="Connection and history details" data-testid="session-health">{readOnly ? "Offline" : streamState === "live" ? "Live" : "Connecting"}</button></Popover.Trigger>
            <Popover.Portal><Popover.Content sideOffset={8} collisionPadding={12} className="z-50 w-72 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 text-xs text-[var(--text-secondary)]">
              <p>Stream: <span data-testid="stream-status">{readOnly ? "stale" : streamState}</span></p>
              <p className="mt-2">History: <span data-testid="history-status">{historyState}</span></p>
              <p className="mt-2 break-all font-mono">{session.sessionId}</p>
              <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap" data-testid="native-events">{diagnosticsOpen ? JSON.stringify(recentEvents, null, 2) : ""}</pre>
            </Popover.Content></Popover.Portal>
          </Popover.Root>
          {running ? (
            <Button
              className="h-8 min-h-8 px-2.5 py-1 text-xs"
              tone="danger"
              icon={CircleStop}
              disabled={!active || mutation.isPending || uploading || preparingImages || Boolean(uncertain)}
              onClick={() => dispatch(
                session.harness === "codex"
                  ? { harness: "codex", command: { type: "interrupt" } }
                  : { harness: "copilot", command: { type: "interrupt" } },
                "Interrupt requested",
              )}
              data-testid="interrupt-button"
            >
              Interrupt
            </Button>
          ) : null}
        </div>
      </header>

      {sessionFailure ? <SessionErrorBanner failure={sessionFailure} onOpenTerminal={() => setWorkspaceView("terminal")} /> : null}

      <Tabs.Content value="chat" className="flex min-h-0 flex-1 flex-col outline-none">
      {historyError ? (
        <p
          className="border-b border-[var(--status-waiting)]/15 bg-[var(--status-waiting)]/[0.06] px-4 py-2 text-xs text-[var(--status-waiting)] sm:px-6"
          role="alert"
          data-testid="history-error"
        >
          {historyError}
        </p>
      ) : null}

      {!historyDone || historyState === "failed" ? <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-subtle)] px-4 py-1.5 text-xs text-[var(--text-secondary)] [@media(max-height:500px)]:py-0" data-testid="history-pagination">
        <span>{loadingAll ? "Loading latest messages…" : "Earlier messages loaded"} · {historyCount.toLocaleString()} items</span>
        {historyState === "loading" ? <button className="min-h-9 text-[var(--accent)]" onClick={() => historyRead.current?.abort()} data-testid="cancel-history-load">{loadingAll ? "Stop loading" : "Cancel"}</button> : <>
          <button className="min-h-9 text-[var(--accent)]" onClick={() => void readHistory()} data-testid="load-more-history">{historyState === "failed" ? "Retry history" : "Next 100"}</button>
          <button className="min-h-9 text-[var(--accent)]" onClick={() => void readHistory(true)} data-testid="load-all-history">Load to latest</button>
        </>}
      </div> : null}
      <VirtualTranscript ref={transcript} store={store} loading={historyState === "loading"} unavailable={historyState === "failed"} working={active && running && !sessionFailure} />

      {pendingInteractions.length > 0 ? (
        <div
          className="max-h-[42vh] overflow-y-auto border-t border-[var(--status-waiting)]/15 bg-[var(--surface-shell)] py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          role="region"
          aria-label="Pending agent interactions"
          tabIndex={0}
        >
          <fieldset disabled={readOnly}><InteractionCards interactions={pendingInteractions} /></fieldset>
        </div>
      ) : null}

      <div className="session-composer border-t border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3 py-3 sm:px-5 [@media(max-height:500px)]:py-1"
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void attachImages([...event.dataTransfer.files]); } }}>
        <div className={classes("mx-auto max-w-[76ch]", draftImages.length > 0 && "[@media(max-height:500px)]:grid [@media(max-height:500px)]:grid-cols-[auto_minmax(0,1fr)] [@media(max-height:500px)]:items-end [@media(max-height:500px)]:gap-x-3")}>
          {draftImages.length > 0 ? <div className="mb-2 flex max-h-28 gap-2 overflow-x-auto [@media(max-height:500px)]:mb-0 [@media(max-height:500px)]:max-w-28" aria-label="Image attachments" data-testid="image-attachments">
            {draftImages.map((image) => <div className="relative shrink-0" key={image.id}>
              <img className="h-20 w-24 [@media(max-height:500px)]:h-10 rounded border border-[var(--border-subtle)] object-contain" src={image.url} alt={image.file.name} />
              <button className="absolute right-0 top-0 grid size-9 place-items-center rounded bg-[var(--surface-shell)]" disabled={uploading || mutation.isPending || Boolean(uncertain)} aria-label={`Remove ${image.file.name}`} onClick={() => { URL.revokeObjectURL(image.url); setDraftImages((current) => current.filter((item) => item.id !== image.id)); }}><X className="size-4" /></button>
            </div>)}
          </div> : null}
          <div className="relative rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] transition focus-within:border-[var(--accent)]/40 focus-within:ring-2 focus-within:ring-[var(--accent)]/[0.08]">
            {suggestions.length ? <div className="absolute bottom-full left-0 z-30 mb-2 max-h-[min(360px,45dvh)] w-full overflow-y-auto overscroll-contain rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-1.5 shadow-lg" id={slashMenuId} role="listbox" tabIndex={0} aria-activedescendant={`${slashMenuId}-${selectedSlash}`} onKeyDown={event => { if (event.key !== "Tab") keyboardSend(event); }} aria-label="Slash commands" data-testid="slash-menu">
              {suggestions.map((item, index) => <button key={item.name} id={`${slashMenuId}-${index}`} type="button" role="option" aria-selected={index === selectedSlash} tabIndex={-1}
                className={classes("flex min-h-11 w-full items-center gap-3 rounded px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--surface-hover)]", index === selectedSlash && "bg-[var(--surface-hover)]")}
                onMouseDown={event => event.preventDefault()} onClick={() => chooseSlash(item.name)} data-testid={`slash-option-${item.name}`}>
                <span className="w-24 shrink-0 font-mono">/{item.name}</span><span className="text-xs text-[var(--text-secondary)]">{item.description}</span>
              </button>)}
            </div> : null}
            <Textarea
              ref={promptInput}
              aria-label="Message this agent"
              aria-autocomplete="list"
              aria-controls={suggestions.length ? slashMenuId : undefined}
              aria-activedescendant={suggestions.length ? `${slashMenuId}-${selectedSlash}` : undefined}
              className="block min-h-10 max-h-48 resize-none [field-sizing:content] [@media(max-height:500px)]:max-h-16 [@media(max-height:500px)]:leading-5 border-0 bg-transparent text-sm leading-6 focus:ring-0"
              rows={1}
              value={prompt}
              onChange={(event) => { setPrompt(event.target.value); setSlashIndex(0); setSlashDismissed(null); }}
              onKeyDown={keyboardSend}
              onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void attachImages(files); } }}
              placeholder={readOnly ? "Reconnect the host before sending a message" : active ? "Message this agent, or / for commands…" : "Resume this session before sending a message"}
              disabled={!active || mutation.isPending || uploading || preparingImages || Boolean(uncertain)}
              data-testid="prompt-input"
            />
            <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 sm:gap-2">
              <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" multiple className="hidden" onChange={(event) => { void attachImages([...(event.target.files ?? [])]); event.target.value = ""; }} data-testid="image-file-input" />
              <Button icon={ImagePlus} disabled={!active || mutation.isPending || uploading || preparingImages || Boolean(uncertain) || imageLimits.support === "unsupported"} aria-label="Attach images" title={imageLimits.support === "unsupported" ? "The applied model does not accept images" : "Attach images"} onClick={() => imagePicker.current?.click()} data-testid="attach-images-button" />
              <ModelPicker session={session} models={models.data ?? []} loading={models.isPending} loadError={models.isError}
                onRetryModels={() => { void models.refetch(); }} disabled={!active || busy} open={settingsOpen} onOpenChange={value => { setSettingsOpen(value); if (value) setActionStatus(""); }}
                section={settingsSection} onSectionChange={setSettingsSection} status={actionStatus}
                onModel={value => changeSetting(`/model ${value}`)} onMode={value => changeSetting(`/mode ${value}`)} onEffort={value => changeSetting(`/effort ${value}`)} />
              <Button className="min-w-0 shrink-0 px-2 text-xs" disabled={!active || busy} onClick={() => openSettings("mode")} aria-label="Change agent mode" data-testid="composer-mode-button">
                {session.harnessSettings?.mode === "plan" ? "Plan" : session.harnessSettings?.mode === "default" ? "Agent" : session.harnessSettings?.mode === "interactive" ? "Interactive" : session.harnessSettings?.mode ?? "Mode"}
              </Button>
              {session.harness === "codex" && session.harnessSettings?.effort ? <button className="hidden min-h-9 shrink-0 text-xs text-[var(--text-secondary)] lg:block" disabled={!active || busy} onClick={() => openSettings("effort")} aria-label="Change reasoning effort" data-testid="composer-effort-button">{humanizeStatus(session.harnessSettings.effort)}</button> : null}
              <span className="sr-only">{settingsSummary}</span>
              <div className="ml-auto flex gap-1.5">
                <Button
                  className={running && !isSlash ? undefined : "hidden"}
                  icon={CornerDownRight}
                  disabled={!active || !running || (!prompt.trim() && !draftImages.length) || mutation.isPending || uploading || preparingImages || Boolean(uncertain)}
                  onClick={() => send("steer")}
                  data-testid="steer-button"
                >
                  Steer
                </Button>
                <Button
                  tone="primary"
                  icon={mutation.isPending ? LoaderCircle : Send}
                  className={mutation.isPending ? "[&_svg]:animate-spin" : undefined}
                  disabled={!active || (!prompt.trim() && !draftImages.length) || mutation.isPending || uploading || preparingImages || Boolean(uncertain)}
                  onClick={() => send("send")}
                  data-testid="send-button"
                >
                  {isSlash ? "Run" : "Send"}
                </Button>
              </div>
            </div>
          </div>
          {uploading ? <button className="col-span-full min-h-9 text-xs text-[var(--accent)]" onClick={() => imageUpload.current?.abort()}>Cancel upload</button> : null}
          {uncertain && !mutation.isPending ? <button className="col-span-full min-h-9 text-xs text-[var(--accent)]" onClick={() => executeAction({ request: uncertain.request, envelope: uncertain, success: "Command reconciled", ...(uncertainPrompt !== null ? { consumePrompt: uncertainPrompt } : {}) })} disabled={readOnly} data-testid="reconcile-command">Check the original command</button> : null}
          <div className={classes(!actionStatus && "hidden sm:flex", "col-span-full mt-1.5 flex min-h-6 items-center justify-between gap-3 [@media(max-height:500px)]:mt-0 [@media(max-height:500px)]:min-h-0")}>
            <p className="min-w-0 truncate text-xs text-[var(--text-secondary)]" role="status" title={actionStatus} data-testid="action-status">{actionStatus}</p>
            <span className="hidden shrink-0 text-xs text-[var(--text-secondary)] sm:inline [@media(max-height:500px)]:hidden">/ for commands · Shift+Enter for newline</span>
          </div>

        </div>
      </div>
      </Tabs.Content>
      <Tabs.Content value="subagents" className="flex min-h-0 flex-1 flex-col outline-none">
        <SubagentView transcript={sessionTranscript} />
      </Tabs.Content>
      <Tabs.Content value="terminal" className="flex min-h-0 flex-1 flex-col outline-none">
        <Suspense fallback={<p className="grid min-h-52 place-items-center text-sm text-[var(--text-muted)]" role="status">Loading terminal controls…</p>}>
          {readOnly ? <p className="p-4 text-sm text-[var(--text-secondary)]" role="status">Reconnect the host to use its terminal.</p> : <TerminalPanel session={session} capability={terminalCapability} />}
        </Suspense>
      </Tabs.Content>
    </Tabs.Root></ImageSessionProvider>
  );
}

function StatusLabel({ tone, children }: { readonly tone: ReturnType<typeof runtimeTone>; readonly children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={classes(
        "size-1.5 rounded-full",
        tone === "good"
          ? "bg-[var(--status-live)]"
          : tone === "warn"
            ? "bg-[var(--status-waiting)]"
            : tone === "bad"
              ? "bg-[var(--status-error)]"
              : "bg-[var(--text-muted)]",
      )} aria-hidden="true" />
      {children}
    </span>
  );
}

function commandStatus(success: string, record: CommandRecord): string {
  if (record.state === "succeeded") return success;
  if (record.state === "outcomeUnknown") {
    return `Outcome unknown for command ${record.commandId}; it will not be retried automatically.`;
  }
  if (record.state === "failed") return `Command failed: ${record.error ?? record.commandId}`;
  return `Command ${record.state}: ${record.commandId}`;
}

function runtimeTone(status: SessionRecord["runtimeStatus"]): "good" | "warn" | "bad" | "neutral" {
  if (status === "idle" || status === "running") return "good";
  if (status === "waitingForInput") return "warn";
  if (status === "error") return "bad";
  return "neutral";
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

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function humanizeStatus(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll(/[./_-]+/g, " ")
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
