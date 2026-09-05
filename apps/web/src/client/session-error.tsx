import { memo } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { NativeFailure } from "./native-errors.js";

export const SessionErrorBanner = memo(function SessionErrorBanner({ failure, onOpenTerminal }: {
  readonly failure: NativeFailure;
  readonly onOpenTerminal?: () => void;
}) {
  return <aside className="shrink-0 border-b border-[var(--status-error)]/30 bg-[var(--status-error)]/[0.06] px-4 py-2 [@media(max-height:500px)]:py-0"
    data-testid="session-error-banner" data-error-code={failure.code}>
    <div className="flex items-center justify-between gap-3">
      <div role="alert" className="min-w-0 text-sm">
        <p className="font-medium text-[var(--status-error)]">{failure.title}</p>
        <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)] [@media(max-height:500px)]:hidden">{failure.guidance}</p>
      </div>
      <Popover.Root>
        <Popover.Trigger className="min-h-9 shrink-0 text-xs text-[var(--text-primary)] underline underline-offset-4" data-testid="session-error-details">Details</Popover.Trigger>
        <Popover.Portal><Popover.Content sideOffset={8} collisionPadding={12} className="z-50 max-h-[65dvh] w-96 max-w-[calc(100vw-24px)] overflow-y-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 shadow-lg" aria-label="Agent error details">
          <p className="text-sm font-medium text-[var(--status-error)]">{failure.title}</p>
          <p className="mt-2 text-sm text-[var(--text-primary)]">{failure.guidance}</p>
          <FailureDetails failure={failure} />
          {failure.code === "detailsUnavailable" && onOpenTerminal ? <Popover.Close asChild><button className="mt-3 min-h-11 text-sm text-[var(--accent)] underline" onClick={onOpenTerminal}>View Terminal</button></Popover.Close> : null}
          <Popover.Close className="mt-3 block min-h-9 text-xs text-[var(--text-secondary)] underline">Close details</Popover.Close>
        </Popover.Content></Popover.Portal>
      </Popover.Root>
    </div>
  </aside>;
});

export function NativeErrorNotice({ failure }: { readonly failure: NativeFailure }) {
  return <div className="w-full min-w-0 rounded-md border border-[var(--status-error)]/30 bg-[var(--status-error)]/[0.06] p-3 text-sm" data-testid="native-error-notice">
    <p className="font-medium text-[var(--status-error)]">{failure.title}</p>
    <p className="mt-1 text-[var(--text-primary)]">{failure.guidance}</p>
    <FailureDetails failure={failure} />
  </div>;
}

function FailureDetails({ failure }: { readonly failure: NativeFailure }) {
  return <>
    <p className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-[var(--text-secondary)]" tabIndex={0}>{failure.message}</p>
    {failure.code ? <p className="mt-2 break-all font-mono text-xs text-[var(--text-muted)]">{failure.code}</p> : null}
    {failure.details ? <details className="mt-2 text-xs text-[var(--text-secondary)]">
      <summary className="min-h-9 cursor-pointer py-2">Additional details</summary>
      <pre tabIndex={0} className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{failure.details}</pre>
    </details> : null}
  </>;
}
