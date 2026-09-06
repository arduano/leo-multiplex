import { memo, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer, type Range } from "@tanstack/react-virtual";
import { flushSync } from "react-dom";
import { ArrowDown, ChevronRight } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { TranscriptImagePreview, isLocalImagePath } from "./image-media.js";
import { type TimelineEntry } from "./transcript.js";
import { TranscriptStore } from "./transcript-store.js";
import { Badge, Button, classes } from "./ui.js";
import { NativeErrorNotice } from "./session-error.js";

export interface TranscriptHandle { followLatest(): void; }

const TRANSCRIPT_WINDOW = 200;
const executionEntry = (entry: TimelineEntry) => entry.kind === "tool" || entry.kind === "reasoning" || entry.kind === "subagent" || entry.kind === "raw";
/** Keep a full readable window around the viewport, shifting it at either end. */
function transcriptRange({ startIndex, endIndex, count }: Range): number[] {
  const size = Math.min(count, TRANSCRIPT_WINDOW);
  const start = Math.max(0, Math.min(count - size, Math.floor((startIndex + endIndex + 1 - size) / 2)));
  return Array.from({ length: size }, (_, index) => start + index);
}

/** Composer edits do not traverse history. Rich Markdown stays near the viewport. */
export const VirtualTranscript = memo(forwardRef<TranscriptHandle, {
  readonly store: TranscriptStore; readonly loading: boolean; readonly unavailable?: boolean; readonly working?: boolean;
}>(function VirtualTranscript({ store, loading, unavailable = false, working = false }, ref) {
  const version = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const userScrolling = useRef(false);
  const userScrollDirection = useRef<"earlier" | "later" | "unknown">("unknown");
  const touchY = useRef<number | undefined>(undefined);
  const previousActivity = useRef(store.activity);
  const previousCount = useRef(store.count);
  const previousHistoryCount = useRef(store.historyCount);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const [unread, setUnread] = useState(0);
  const ordering = store.ordering;
  const getItemKey = useCallback((index: number) => store.at(index)!.id, [store, ordering]);
  const virtualizer = useVirtualizer({
    count: store.count, getScrollElement: () => viewport.current, getItemKey,
    estimateSize: (index) => {
      const entry = store.at(index)!;
      return executionEntry(entry) ? 44 : 160;
    },
    rangeExtractor: transcriptRange, paddingStart: 24, paddingEnd: working ? 60 : 24,
    // Our row observer commits the complete measurement batch once. Flushing
    // each row separately would repeatedly rebuild the same visible window.
    useFlushSync: false,
  });
  const rowObserver = useMemo(() => new ResizeObserver((entries) => {
    // A scroll correction and the offsets it corrects must reach the same
    // paint. Deferring React's offsets after changing scrollTop makes the
    // conversation jump out and back on alternating frames.
    flushSync(() => {
      for (const entry of entries) {
        const element = entry.target as HTMLDivElement;
        const index = Number(element.dataset.index);
        if (!element.isConnected || store.at(index)?.id !== element.dataset.rowKey) continue;
        const height = entry.borderBoxSize[0]?.blockSize;
        if (height !== undefined) virtualizer.resizeItem(index, Math.round(height));
      }
    });
  }), [store, virtualizer]);
  useEffect(() => () => rowObserver.disconnect(), [rowObserver]);
  const observeRow = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    rowObserver.observe(element, { box: "border-box" });
    return () => rowObserver.unobserve(element);
  }, [rowObserver]);
  // Promotion is one-way for a mounted row. Replacing Markdown with a plain
  // preview as it crosses the viewport changes its height, which changes the
  // viewport range and can immediately promote it again in a feedback loop.
  const richRows = useRef(new Set<string | number | bigint>());
  const jump = useCallback(() => {
    following.current = true;
    userScrolling.current = false;
    setUnread(0);
    if (store.count) virtualizer.scrollToIndex(store.count - 1, { align: "end" });
  }, [store, virtualizer]);
  useImperativeHandle(ref, () => ({ followLatest: jump }), [jump]);
  useLayoutEffect(() => {
    const added = Math.max(0, store.count - previousCount.current);
    const liveChanged = store.activity !== previousActivity.current;
    previousActivity.current = store.activity;
    previousCount.current = store.count;
    if (following.current) jump();
    else {
      if (store.historyCount !== previousHistoryCount.current && anchor.current) {
        const index = store.indexOf(anchor.current.id);
        const offset = index >= 0 ? virtualizer.getOffsetForIndex(index, "start")?.[0] : undefined;
        if (offset !== undefined) virtualizer.scrollToOffset(offset + anchor.current.offset);
      }
      if (liveChanged) setUnread((current) => current + Math.max(1, added));
    }
    previousHistoryCount.current = store.historyCount;
  }, [version, store, jump, working]);
  useEffect(() => {
    const element = viewport.current?.firstElementChild;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (following.current) jump(); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [jump]);
  const beginUserScroll = (direction: "earlier" | "later" | "unknown") => {
    userScrolling.current = true;
    userScrollDirection.current = direction;
    if (direction === "earlier") following.current = false;
  };
  const rows = virtualizer.getVirtualItems();
  const mountedKeys = new Set(rows.map((row) => row.key));
  for (const key of richRows.current) if (!mountedKeys.has(key)) richRows.current.delete(key);
  return <div className="relative min-h-0 flex-1">
    <div ref={viewport} className="h-full overflow-x-hidden overflow-y-auto overscroll-contain bg-[var(--surface-canvas)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      style={{ overflowAnchor: "none" }}
      onWheel={(event) => { if (event.deltaY) beginUserScroll(event.deltaY < 0 ? "earlier" : "later"); }}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMove={(event) => {
        const nextY = event.touches[0]?.clientY;
        if (nextY !== undefined && touchY.current !== undefined && nextY !== touchY.current) beginUserScroll(nextY > touchY.current ? "earlier" : "later");
        touchY.current = nextY;
      }}
      onPointerDown={(event) => { if (event.target === event.currentTarget) beginUserScroll("unknown"); }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
          const earlier = ["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey;
          beginUserScroll(earlier ? "earlier" : "later");
        }
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        // New pages, image measurements, and virtual scroll correction also
        // emit scroll events. Only an operator gesture can leave latest-follow.
        if (userScrolling.current) {
          following.current = userScrollDirection.current !== "earlier" && element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          if (following.current) userScrolling.current = false;
        }
        const row = virtualizer.getVirtualItems().find((item) => item.end > element.scrollTop);
        if (row) anchor.current = { id: String(row.key), offset: element.scrollTop - row.start };
        if (following.current) setUnread(0);
      }} role="region" aria-label="Agent conversation" tabIndex={0} data-testid="chat-transcript" data-total-entries={store.count}>
      {store.count === 0 && working ? <div className="mx-auto flex h-full max-w-[80ch] flex-col justify-end px-4 pb-6 sm:px-8"><WorkingIndicator /></div>
      : store.count === 0 ? <div className="mx-auto grid h-full max-w-[72ch] content-center px-6 pb-12 text-sm text-[var(--text-secondary)]">
        <p className="mb-2 text-lg font-medium text-[var(--text-primary)]">{loading ? "Opening conversation…" : unavailable ? "History is unavailable" : "Start a conversation"}</p>
        <p>{loading ? "Reading native history." : unavailable ? "Retry loading above. Your session is still selected." : "Send a message to begin working with this agent."}</p>
      </div> : <div className="relative mx-auto w-full min-w-0 max-w-[80ch] transition-none" style={{ height: virtualizer.getTotalSize() }}>
        {/* One positioned window, with natural flow inside it. A row growing
            during Markdown/image/layout changes must move its neighbors in
            the same browser layout, before ResizeObserver updates estimates. */}
        <div className="absolute left-0 top-0 w-full min-w-0 transition-none" style={{ transform: `translateY(${rows[0]?.start ?? 0}px)` }}>
        {rows.map((row) => {
          const entry = store.at(row.index)!;
          const compact = executionEntry(entry) && !entry.failure;
          if (row.index >= (virtualizer.range?.startIndex ?? 0) - 5 && row.index <= (virtualizer.range?.endIndex ?? 0) + 5) richRows.current.add(row.key);
          const rich = richRows.current.has(row.key);
          return <div key={row.key} data-index={row.index} data-row-key={row.key}
            ref={observeRow} className={classes("w-full min-w-0 px-4 sm:px-8 transition-none", compact ? "pb-2" : "pb-6")}
            style={{ contentVisibility: "auto", containIntrinsicBlockSize: `auto ${Math.max(0, row.size - (compact ? 8 : 24))}px` }}>
            <TimelineItem entry={entry} store={store} rich={rich} />
          </div>;
        })}
        {working && rows.at(-1)?.index === store.count - 1 ? <div className="px-4 sm:px-8"><WorkingIndicator /></div> : null}
        </div>
      </div>}
    </div>
    {unread > 0 ? <Button className="absolute bottom-3 left-1/2 min-h-9 -translate-x-1/2 bg-[var(--surface-raised)] px-3 py-1 text-xs" icon={ArrowDown} onClick={jump} data-testid="jump-to-latest">Latest · {unread} new</Button> : null}
  </div>;
}));

function WorkingIndicator() {
  return <div className="flex min-h-6 items-center gap-2 text-xs text-[var(--text-secondary)]" role="status" data-testid="agent-working-indicator">
    <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-[var(--accent)] motion-reduce:animate-none" />
    <span>Working…</span>
  </div>;
}

const BODY_PAGE_SIZE = 16_384;
/** Parse at most one bounded Markdown segment; tool output stays literal. */
function BoundedBody({ body, sourceKey, store, rich = true, plain = false, code = false, pending }: {
  readonly body: string; readonly sourceKey: string; readonly store: TranscriptStore; readonly rich?: boolean; readonly plain?: boolean; readonly code?: boolean; readonly pending?: boolean | undefined;
}) {
  const pages = Math.max(1, Math.ceil(body.length / BODY_PAGE_SIZE));
  const [selectedPage, setSelectedPage] = useState<number | null>(() => store.view(sourceKey)?.page ?? null);
  const selectPage = (page: number | null) => { setSelectedPage(page); store.rememberView(sourceKey, { page }); };
  const page = Math.min(selectedPage ?? (pending ? pages - 1 : 0), pages - 1);
  const text = pages > 1 ? body.slice(page * BODY_PAGE_SIZE, (page + 1) * BODY_PAGE_SIZE) : body;
  return <>
    {pages > 1 ? <div className="my-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]" data-testid="long-content-controls">
      <span>Long output · Part {page + 1} of {pages}</span>
      <button className="min-h-9 px-2 underline" disabled={page === 0} onClick={() => selectPage(page - 1)}>Previous</button>
      <button className="min-h-9 px-2 underline" disabled={page === pages - 1} onClick={() => selectPage(page + 1)}>Next</button>
      <button className="min-h-9 px-2 underline" disabled={page === pages - 1} onClick={() => selectPage(pending ? null : pages - 1)}>Latest</button>
    </div> : null}
    {code ? <pre tabIndex={0} className="max-h-80 max-w-full overflow-auto px-3 py-2 font-mono text-xs leading-5 text-[var(--text-secondary)]" data-testid="command-output">{text}</pre>
      : plain ? <div className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words">{text}</div>
      // All 200 rows contain readable text. Parse Markdown only near the
      // viewport so a jump does not synchronously parse 200 complex messages.
      : !rich ? <div className="whitespace-pre-wrap break-words">{text}</div>
      : <MarkdownBody body={text} sourceKey={sourceKey} offset={page * BODY_PAGE_SIZE} />}
  </>;
}

const TimelineItem = memo(function TimelineItem({ entry, store, rich }: { readonly entry: TimelineEntry; readonly store: TranscriptStore; readonly rich: boolean }) {
  const isExecution = executionEntry(entry);
  const isFailed = entry.status === "failed" || entry.status === "error";
  const [expanded, setExpanded] = useState(() => store.view(entry.id)?.expanded ?? Boolean(entry.pending || isFailed));
  const lifecycle = `${Boolean(entry.pending)}:${isFailed}`;
  const lastLifecycle = useRef(lifecycle);
  useEffect(() => {
    if (lastLifecycle.current === lifecycle) return;
    lastLifecycle.current = lifecycle;
    const next = Boolean(entry.pending || isFailed);
    setExpanded(next);
    store.rememberView(entry.id, { expanded: next });
  }, [lifecycle, entry.id, entry.pending, isFailed, store]);
  if (entry.failure) return <article data-testid="chat-message" data-role="notice" data-entry-id={entry.id} data-native-item-id={entry.nativeItemId} data-thread-id={entry.threadId} data-turn-id={entry.turnId} className="min-w-0 max-w-full">
    <NativeErrorNotice failure={entry.failure} />
  </article>;
  if (isExecution) {
    const hasOutput = /\S/.test(entry.body);
    const heading = <>
      {hasOutput ? <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-[var(--text-muted)] transition group-open:rotate-90" /> : <span aria-hidden="true" className="w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate" title={entry.title}>{entry.title}</span>
      {entry.status ? <ExecutionStatus status={entry.status} /> : entry.pending ? <ExecutionStatus status="running" /> : <span className="text-xs text-[var(--text-muted)]">Done</span>}
    </>;
    const headingClass = "flex min-h-9 items-center gap-2 px-1 py-1 text-xs text-[var(--text-secondary)]";
    return (
      <article
        className="execution-row min-w-0 max-w-full border-l border-[var(--border-subtle)] pl-2"
        data-testid="chat-message"
        data-role={entry.kind}
        data-entry-id={entry.id}
        data-native-item-id={entry.nativeItemId}
        data-thread-id={entry.threadId}
        data-turn-id={entry.turnId}
      >
        {hasOutput ? <details className="group min-w-0 max-w-full overflow-hidden" open={expanded} onToggle={(event) => {
          setExpanded(event.currentTarget.open);
          store.rememberView(entry.id, { expanded: event.currentTarget.open });
        }}>
          <summary className={classes(headingClass, "cursor-pointer list-none [@media(pointer:coarse)]:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/60")}>{heading}</summary>
          {expanded ? <div className="pb-2 text-xs leading-5 text-[var(--text-secondary)]"><BoundedBody body={entry.body} sourceKey={entry.id} store={store} plain code={entry.kind === "tool" || entry.kind === "raw"} pending={entry.pending} /></div> : null}
        </details> : <div className={headingClass}>{heading}</div>}
        {entry.images?.map((image, index) => <TranscriptImagePreview key={index} {...image} sourceKey={`${entry.id}:image:${index}`} />)}
      </article>
    );
  }
  return (
    <article
      className={classes(
        "group flex min-w-0 max-w-full gap-3",
        entry.kind === "user" && "justify-end",
      )}
      data-testid="chat-message"
      data-role={entry.kind}
      data-entry-id={entry.id}
      data-native-item-id={entry.nativeItemId}
      data-thread-id={entry.threadId}
      data-turn-id={entry.turnId}
    >
      <div className={classes("min-w-0", entry.kind === "user" ? "max-w-[92%] sm:max-w-[88%]" : "flex-1")}>
        <div className={classes("mb-1 flex items-center gap-2", entry.kind === "user" && "justify-end")}>
          <span className="text-xs font-medium text-[var(--text-secondary)]">{entry.title}</span>
          {entry.status ? <Badge tone={entry.status === "failed" ? "bad" : entry.pending ? "warn" : "neutral"}>{entry.status}</Badge> : null}
          {entry.pending ? <span className="size-1.5 rounded-full bg-[var(--accent)]" title="Streaming" /> : null}
        </div>
        <div className={classes(
          "min-w-0 break-words text-sm leading-6",
          entry.kind === "user"
            ? "rounded-lg bg-[var(--accent)]/10 px-3.5 py-2.5 text-[var(--text-primary)]"
            : entry.kind === "assistant"
              ? "text-[var(--text-primary)]"
              : entry.kind === "plan"
                ? "rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3.5 py-3 text-[var(--text-primary)]"
                : entry.status === "failed"
                  ? "rounded-md border border-[var(--status-error)]/20 bg-[var(--status-error)]/[0.06] px-3 py-2 text-[var(--status-error)]"
                  : "rounded-md border border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3 py-2 text-[var(--text-secondary)]",
        )}>
          <BoundedBody body={entry.body || (entry.images?.length ? "" : "…")} sourceKey={entry.id} store={store} rich={rich} plain={entry.kind === "user"} pending={entry.pending} />
          {entry.images?.map((image, index) => <TranscriptImagePreview key={index} {...image} sourceKey={`${entry.id}:image:${index}`} />)}
        </div>
      </div>
    </article>
  );
});
function MarkdownBody({ body, sourceKey, offset = 0 }: { readonly body: string; readonly sourceKey: string; readonly offset?: number }) {
  // ReactMarkdown uses these functions as component types. Keep their identity
  // stable so transcript refreshes preserve image dialogs, blobs, and focus.
  const components = useMemo<Components>(() => ({
    pre: ({ node: _node, ...props }) => <pre {...props} tabIndex={0} aria-label="Code block" />,
    table: ({ node: _node, ...props }) => <table {...props} tabIndex={0} />,
    a: ({ node: _node, ...props }) => <a {...props} rel="noreferrer" target="_blank" />,
    img: ({ node, alt, src }) => src && isLocalImagePath(src)
      ? <TranscriptImagePreview path={decodeMarkdownImagePath(src)} alt={alt || "Image"} sourceKey={`${sourceKey}:markdown:${offset + (node?.position?.start.offset ?? 0)}`} />
      : <span className="inline-flex rounded border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--text-secondary)]">{src && /^https?:\/\//i.test(src) ? <a href={src} rel="noreferrer" target="_blank">{alt || "External image"}</a> : alt || "Unsupported image reference"}</span>,
  }), [sourceKey, offset]);
  return (
    <div className="space-y-2 [&_a]:text-[var(--accent)] [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-subtle)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_code]:rounded [&_code]:bg-[var(--surface-canvas)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-inherit [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:ml-5 [&_li]:pl-1 [&_ol]:list-decimal [&_p]:whitespace-pre-wrap [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-[var(--border-subtle)] [&_pre]:bg-[var(--surface-canvas)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-xs [&_td]:border [&_td]:border-[var(--border-subtle)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border-subtle)] [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function decodeMarkdownImagePath(path: string): string {
  try { return decodeURIComponent(path); } catch { return path; }
}

function ExecutionStatus({ status }: { readonly status: string }) {
  const failed = status === "failed" || status === "error";
  const running = status === "running" || status === "inProgress";
  return (
    <span title={status} className={classes(
      "shrink-0 text-xs",
      failed ? "text-[var(--status-error)]" : running ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
    )}>{humanizeStatus(status)}</span>
  );
}


function humanizeStatus(value: string): string {
  if (value === "inProgress" || value === "running") return "Running";
  if (value === "completed") return "Done";
  const label = value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll(/[./_-]+/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
