import { memo, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ChevronRight } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { TranscriptImagePreview, isLocalImagePath } from "./image-media.js";
import { type TimelineEntry } from "./transcript.js";
import { TranscriptStore } from "./transcript-store.js";
import { Badge, Button, classes } from "./ui.js";

export interface TranscriptHandle { followLatest(): void; }

/** Composer edits do not traverse history. Markdown sees measured rows only. */
export const VirtualTranscript = memo(forwardRef<TranscriptHandle, {
  readonly store: TranscriptStore; readonly loading: boolean;
}>(function VirtualTranscript({ store, loading }, ref) {
  const version = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
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
      return entry.kind === "tool" || entry.kind === "reasoning" || entry.kind === "subagent" ? 68 : 160;
    },
    overscan: 5, paddingStart: 24, paddingEnd: 24,
    // Batch height measurements from one commit; flushing each row separately
    // repeatedly recalculates offsets during a jump deep into a long thread.
    useFlushSync: false,
  });
  const jump = useCallback(() => {
    following.current = true;
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
  }, [version, store, jump]);
  useEffect(() => {
    const element = viewport.current?.firstElementChild;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (following.current) jump(); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [jump]);
  return <div className="relative min-h-0 flex-1">
    <div ref={viewport} className="h-full overflow-x-hidden overflow-y-auto overscroll-contain bg-[var(--surface-canvas)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        const row = virtualizer.getVirtualItems().find((item) => item.end > element.scrollTop);
        if (row) anchor.current = { id: String(row.key), offset: element.scrollTop - row.start };
        if (following.current) setUnread(0);
      }} role="region" aria-label="Agent conversation" tabIndex={0} data-testid="chat-transcript" data-total-entries={store.count}>
      {store.count === 0 ? <div className="mx-auto grid h-full max-w-[72ch] content-center px-6 pb-12 text-sm text-[var(--text-secondary)]">
        <p className="mb-2 text-lg font-medium text-[var(--text-primary)]">{loading ? "Opening conversation…" : "Start a conversation"}</p>
        <p>{loading ? "Reading native history." : "Send a message to begin working with this agent."}</p>
      </div> : <div className="relative mx-auto w-full min-w-0 max-w-[80ch]" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => <div key={row.key} data-index={row.index}
          ref={virtualizer.measureElement} className="absolute left-0 top-0 w-full min-w-0 px-4 pb-6 sm:px-8"
          style={{ transform: `translateY(${row.start}px)` }}>
          <TimelineItem entry={store.at(row.index)!} store={store} />
        </div>)}
      </div>}
    </div>
    {unread > 0 ? <Button className="absolute bottom-3 left-1/2 min-h-9 -translate-x-1/2 bg-[var(--surface-raised)] px-3 py-1 text-xs" icon={ArrowDown} onClick={jump} data-testid="jump-to-latest">Latest · {unread} new</Button> : null}
  </div>;
}));

const BODY_PAGE_SIZE = 16_384;
/** Parse at most one bounded Markdown segment; tool output stays literal. */
function BoundedBody({ body, sourceKey, store, plain = false, code = false, pending }: {
  readonly body: string; readonly sourceKey: string; readonly store: TranscriptStore; readonly plain?: boolean; readonly code?: boolean; readonly pending?: boolean | undefined;
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
      : <MarkdownBody body={text} sourceKey={sourceKey} offset={page * BODY_PAGE_SIZE} />}
  </>;
}

const TimelineItem = memo(function TimelineItem({ entry, store }: { readonly entry: TimelineEntry; readonly store: TranscriptStore }) {
  const isExecution = entry.kind === "reasoning" || entry.kind === "tool" || entry.kind === "subagent" || entry.kind === "raw";
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
  if (isExecution) {
    return (
      <article
        className="execution-row min-w-0 max-w-full border-l border-[var(--border-subtle)] pl-3"
        data-testid="chat-message"
        data-role={entry.kind}
        data-entry-id={entry.id}
      >
        <details className="group min-w-0 max-w-full overflow-hidden" open={expanded} onToggle={(event) => {
          setExpanded(event.currentTarget.open);
          store.rememberView(entry.id, { expanded: event.currentTarget.open });
        }}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/60">
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-[var(--text-muted)] transition group-open:rotate-90" />
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            {entry.status ? <ExecutionStatus status={entry.status} /> : entry.pending ? <ExecutionStatus status="running" /> : <span className="text-xs text-[var(--text-muted)]">Done</span>}
          </summary>
          {expanded ? <BoundedBody body={entry.body || "No output"} sourceKey={entry.id} store={store} plain code={entry.kind === "tool" || entry.kind === "raw"} pending={entry.pending} /> : null}
        </details>
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
          <BoundedBody body={entry.body || (entry.images?.length ? "" : "…")} sourceKey={entry.id} store={store} plain={entry.kind === "user"} pending={entry.pending} />
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
    <span className={classes(
      "shrink-0 text-xs",
      failed ? "text-[var(--status-error)]" : running ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
    )}>{humanizeStatus(status)}</span>
  );
}


function humanizeStatus(value: string): string { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll(/[./_-]+/g, " "); }
