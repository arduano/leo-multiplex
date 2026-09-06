# Long-thread memory audit

Audited 2026-09-06 against the personal UI and published Agent Multiplex
`0.2.0` packages. The UI keeps rendering bounded, but its conversation memory
still grows with loaded history. Gateway history forwarding did not accumulate
history in retained heap; native replay and observer buffers can retain much
more memory, including an unnecessary consumed-replay lifetime.

This is an audit and follow-up list. The accompanying compact-widget cleanup
does not implement the memory changes below.

Operator decision, 2026-09-06: roughly 70 MiB of browser heap for this fixture
is acceptable for now, including retaining inactive conversation data for a few
minutes. Keep the current browser behavior; immediate collection and a bounded
transcript page cache are not current priorities. The library's default inactive
cache TTL is five minutes; this audit measured only the first five seconds after
switching and did not verify collection at expiry.

## Evidence and scope

The browser fixture used the production client, Chromium `151.0.7922.173`,
50,000 turns and 100,001 historical items across 1,001 ascending native pages.
Its serialized fixture was 39,566,772 bytes (37.73 MiB). HTTP and WebSocket
responses were intercepted; no real history or provider was involved. CDP
measured the browser renderer separately from the Node fixture generator.
The browser fixture deliberately includes a roughly 2 MiB tool result to stress
bounded rendering; that item exceeds the native envelope limit, so this is not
an end-to-end native payload qualification. The gateway's 16/64 KiB live-event
samples stay below the protocol limit.

The gateway fixture used Node `v24.19.0`, the published gateway projection,
and the personal HTTP surface in an isolated child process. It forwarded
100,000 synthetic history items, followed by four concurrent readers of another
40,000 items, then exercised native journals, a stalled observer and consumed
replay. Source data was synthetic; P2P, native adapters, real authentication
infrastructure and production sessions were outside this fixture. Both audits
made zero model calls.

Private, gitignored evidence:

- `receipts/long-thread/2026-09-06T01-31-59.815Z/manifest.json`: source,
  dependency and build hashes, screenshots, browser metrics and DOM checks.
  Its status is `memory-audit-completed`, **not** a fresh latency qualification.
- `receipts/gateway-memory/2026-09-06T01-32-37.821Z/manifest.json` and
  `SHA256SUMS`: gateway samples and recorded source/dependency hashes. Its
  `passed` status covers this disposable audit's assertions, not production
  memory limits or a complete native deployment qualification.

The machine had substantial concurrent load during this work, and a strict
browser timing run failed its history-import latency gate. That failed run is
diagnostic evidence. The browser memory mode records timing observations without
enforcing the usual latency gates. Its structural checks still ran, including
the 200-message rendering window. Timing results from this audit must not be
presented as newly qualified responsiveness or a guarantee for every device and
payload.

All tables use MiB (1,048,576 bytes). Retained heap means JavaScript heap sampled
after explicit garbage collection. RSS is process resident memory, including
reserved heap pages, native allocations and buffers. It can remain high after
objects become collectible. Browser CDP heap measurements are not whole-browser
RSS and do not establish a bound on decoded images, GPU or other processes.

## Browser measurements

| Stage | Heap before GC | Retained heap |
| --- | ---: | ---: |
| 100 historical items | 16.91 | 9.74 |
| 100,001 historical items | 89.41 | 70.47 |
| Large tool output expanded | 72.12 | 70.24 |
| After scrolling, streaming and mobile resize | 152.52 | 70.04 |
| Switched to a one-item session | 72.15 | 69.12 |
| Five seconds after switching | 69.14 | 69.15 |

The loaded transcript stayed at 200 mounted messages. Scrolling and streaming
generated temporary allocations, but their retained heap stayed near 70 MiB.
Switching sessions removed the visible conversation without promptly releasing
its data: retained heap remained near 69 MiB after GC and a five-second wait.
Local heap-retainer inspection identified cached React Query `queryFn` closures
whose shared component context retained the former transcript store.

The relevant queries are defined inside
[`BoundSessionConsole`](../apps/web/src/client/session-console.tsx), alongside
the transcript store. The global
[`QueryClient`](../apps/web/src/client/main.tsx) leaves cache GC timing at the
library default. Inactive browser queries normally remain for five minutes;
this measurement establishes retention after navigation, not a permanent leak
or proof that every query is eventually released. Command mutations also keep
callbacks that capture the store, so navigation after sending commands needs
its own regression coverage.

[`NativeHistoryPager`](../apps/web/src/client/native-history.ts) and the console
automatically read every oldest-first page to reach the latest messages.
[`TranscriptStore`](../apps/web/src/client/transcript-store.ts) retains all
entries, native raw objects, ordering indexes, hydration records and view state.
[`SessionTranscript`](../apps/web/src/client/session-transcript.ts) also retains
each child's received live entries, whether or not the Subagents view is opened.
None has a transcript byte budget or page eviction. The
[`virtual transcript`](../apps/web/src/client/virtual-transcript.tsx) limits
mounted rows and rendered body segments, not the underlying stored text.

Raw native data and projected bodies sometimes share strings; they are not
universally duplicate copies. Joined reasoning/user content and formatted JSON
tool output allocate additional strings. Retained raw objects and hydration
prefixes add overhead even when there is no second complete text copy.

## Gateway measurements

| Stage | Retained heap | RSS after GC |
| --- | ---: | ---: |
| Idle gateway | 23.89 | 115.09 |
| 1,000 history items forwarded | 25.29 | 134.55 |
| 10,000 history items forwarded | 25.59 | 188.58 |
| 100,000 history items forwarded | 26.06 | 334.96 |
| Four concurrent readers, 40,000 additional items | 26.05 | 352.90 |
| Journal: 4,096 events of 16 KiB | 91.92 | 372.31 |
| 8,192 events ingested; journal still 4,096 | 91.96 | 412.64 |
| Journal: 4,096 events of 64 KiB | 283.93 | 618.55 |
| Journal cleared by source reset | 26.06 | 618.55 |
| Stalled observer: 8,192 queued events of 16 KiB | 156.66 | 643.42 |
| Observer exceeded its item cap; journal remains | 90.77 | 643.42 |
| Reset after observer disposal | 24.97 | 643.42 |
| Resumed subscriber consumed its 4,096-event replay | 90.90 | 645.52 |
| Journal reset; consumed-replay subscriber remains | 90.83 | 645.52 |
| Consumed-replay subscriber released | 24.95 | 645.52 |

History forwarding left retained heap near 26 MiB after 1,400 requests and
313,822,695 cumulative response bytes. The rising RSS alone does not demonstrate
a retained-history leak: heap returned near baseline even though Node kept
resident pages.

Native-event retention scales with payload size. The journal's 4,096-event cap
worked, but changing events from 16 KiB to 64 KiB raised retained heap from
about 92 MiB to 284 MiB. The observer's 8,192-event cap also worked and released
its queued references on overflow. These are count limits, not useful small
byte budgets. Native payloads can approach the protocol's 960 KiB envelope
limit; worst-case count-based retention can therefore reach gigabytes.

Consumed replay exposed a separate defect. In the published
[`AccessGatewayProjection`](https://github.com/arduano/agent-multiplex/blob/v0.2.0/packages/gateway-core/src/projection.ts),
`#subscribe` captures an `initial` replay array and advances an index without
clearing consumed entries. After resetting the journal, retained heap stayed
at 90.83 MiB until that subscriber was released, then fell to 24.95 MiB.
Different long-lived subscribers can pin different obsolete replay windows.

The personal
[`WebSocket egress guard`](../apps/web/src/websocket-egress.ts) limits queued
serialized writes to 8 MiB per socket. It does not bound the projection's
retained event objects, replay arrays or concurrent HTTP work.

## Other reviewed limits

- **Drafts:** [`session-drafts.ts`](../apps/web/src/client/session-drafts.ts)
  retains a module-global slot for every visited binding with no removal policy.
  Each binding may retain up to 50 MiB of attached files and their object URLs.
  Empty slots are also retained. Nonempty drafts and uncertain command envelopes
  must not be silently evicted to fix this.
- **Images:** [`image-media.tsx`](../apps/web/src/client/image-media.tsx) loads
  previews near the viewport and revokes URLs on unmount. It has no combined
  preview/concurrency or decoded-pixel budget. Its extra `Uint8Array` copy before
  Blob creation increases temporary allocation. Image-heavy history and many
  inactive image drafts were not measured by the text fixture.
- **Browser stream:** the console permits 2,048 pending subscription events plus
  a local batch of 64. The
  [published subscription helper](https://github.com/arduano/agent-multiplex/blob/v0.2.0/packages/client/src/resilient-subscription.ts)
  bounds item count, not payload bytes. It serializes processing and unsubscribes
  on overflow. History reads and subscriptions are cancelled on binding changes.
- **Gateway control data:** projection snapshots retain interactions and
  metadata-operation receipts. Live updates upsert them without a retirement
  policy. The
  [control snapshot](https://github.com/arduano/agent-multiplex/blob/v0.2.0/packages/control-node-core/src/catalog.ts)
  deliberately includes completed interactions and all metadata receipts for
  open sessions. Growth here is separate from native history and was not covered
  by this fixture. Any redesign must preserve authority and replay fences.
- **Existing cleanup:** error-state retention caps at 128 bindings; session rows
  cap at 500; rich-row tracking is pruned to mounted rows. Terminal scrollback
  caps at 5,000 lines, writes await xterm processing, and terminal instances,
  event handlers, image URLs and observers have disposal paths.

## Prioritized follow-ups

1. Release consumed gateway replay references promptly. Add byte budgets to
   native journals and subscriber queues with explicit gap/reset recovery.
   Make this in the framework and consume a published release; do not patch
   installed dependencies or silently drop events.
2. Qualify image-heavy, metadata/interaction-heavy and multiple-observer cases,
   and measure the actual deployed process separately. Re-run strict browser
   latency gates on a sufficiently idle machine after memory changes.
3. Reclaim unused empty draft slots; define aggregate draft and preview budgets,
   image read concurrency and decoded-image limits while preserving unsent work.
4. Defer browser transcript memory optimization at the accepted scale. Revisit
   if retention outlives the intended cache TTL or measured memory becomes a
   practical problem. Future coverage should verify expiry after repeated
   session switches and commands without losing drafts or uncertain operations.
   Native latest-first/history-window support and a reloadable page cache remain
   options if larger workloads warrant them.

## Reproduction

After installing dependencies and a compatible Chromium browser:

```bash
npm run build
LEO_MEMORY_AUDIT_ONLY=1 node tests/browser/long-thread.mjs
node scripts/gateway-memory-audit.mjs
```

Set `LEO_TEST_CHROMIUM` to select an existing Chromium executable. Omit
`LEO_MEMORY_AUDIT_ONLY` for the normal strict latency gates. Optional
`LEO_HEAP_SNAPSHOT=1` writes a large diagnostic snapshot after switching sessions;
keep it local. The fixtures use synthetic content, and heap snapshots must never
be taken from authenticated production sessions for publication.
