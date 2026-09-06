# Browser qualification

After `npm run build`, `node tests/browser/work-commands.mjs` checks the
experimental work-command settings hatch with disposable HTTP/IndexedDB fixtures.
It covers hidden personal-only targets, reload recovery, exact-ID retry,
cancel/poll ordering, definite rejections, saved-record review/deletion, endpoint
changes, text-only bounded output and all six responsive/axe viewports. No
native shell, agent or model is contacted. Passing manifests live under
`receipts/work-command-browser/`.

Run `node tests/browser/qualify.mjs` after installing dependencies and a
Playwright-compatible Chromium browser. Set `LEO_TEST_CHROMIUM` to use an
existing browser executable.

The fixture starts a temporary loopback Vite server and intercepts all API and
WebSocket requests. It contacts no host, provider, Codex process, or auth home.
It verifies:

- Image attachment and stable launch construction with HTTPS-only UUID and hash
  APIs unavailable, as on a Tailscale HTTP origin.
- Native user and assistant history must render before any viewport screenshots;
  the conversation retains at least 120 px of height even in short landscape.
- Six responsive viewports, visible composer, no document overflow, keyboard
  sheet dismissal/focus restoration, and no serious or critical axe findings.
- Stale host rows remain visible in browser memory with session and metadata
  drafts preserved; mutations stay disabled until recovery.
- Gateway reconnection and sign-in expiry retain the selected workspace.
- Session switching preserves independent text/image drafts with usable previews.
- Duplicate command submits dispatch once; lost replies retain the exact command
  envelope across session switches, and explicit reconciliation reuses it.
- Lost launch responses, repeated submit events, dialog close/reopen, and retry
  retain exactly one launch ID and request body; terminal settlement unlocks
  the next launch.
- Copilot launch selects its exact workspace profile and native models/modes,
  preserves Windows paths, excludes Codex effort and authentication fields, and
  resets settings when switching hosts or harnesses. Missing profiles explain
  why creation is unavailable. Its form is checked across all six viewports.

The composer/model checks also exercise local slash parsing and keyboard
completion, native reasoning choices, delayed setting acknowledgment, failed and
lost responses, exact-ID reconciliation, image/draft retention, and bounded
model/command panels on portrait and landscape phones.

Native-error checks distinguish current warnings from transcript history. They
verify recovery on a follow-up's native start, output after an automatic retry,
and a current active-status read after navigation missed the start. Historical
error notices remain and a later failure displays a new warning.

Subagent checks interleave parent tools and child messages with deliberately
reused item/turn IDs. Child output and errors must remain in the named Subagents
view; returning to Chat preserves the parent draft. Child history is explicitly
partial, and viewing it sends no agent commands. Desktop and mobile screenshots
and accessibility checks cover the separate view.

Compact execution checks hide undisclosed/whitespace reasoning, preserve real
reasoning and failures, and remove disclosures from tools without output. They
verify keyboard expansion, smaller desktop rows, and 44 px disclosure targets
with a coarse pointer.

Passing screenshots and a manifest covering all UI source, dependency lockfile,
font/license notices, and screenshot checksums are written under the ignored
`receipts/browser/` directory. Failed runs retain diagnostic screenshots only.
The suite rejects source changes during a run.
This qualifies browser behavior against disposable API fixtures; server Access
authentication, real runtime routing, and native Codex require their separate
integration suites.

`node tests/browser/multi-host.mjs` exercises four independent control sources
with 100 sessions, deliberately colliding native IDs, host-specific models,
isolated drafts/history/live events, and six viewport sizes. It also checks
host-name search, a disconnected launch target, empty source pages, and repeated
simultaneous Windows/WSL laptop outages with staggered recovery. No navigation,
reconnect, or model discovery may dispatch a command. Passing source/screenshot
hashes are under `receipts/browser-multi-host/`.
`tests/four-host-routing.test.ts` separately exercises the published real
gateway/control/runtime services with disposable mock agents, including
owner-specific commands/history and repeated two-source outages. Neither fixture
qualifies physical laptop sleep or native Windows/WSL networking.

`node tests/browser/long-thread.mjs` builds the production client into an
isolated receipt directory and opens a disposable 50,000-turn / 100,001-item
conversation. It uses the published oldest-first 100-item native paging
contract. No browser-only shortcuts inject the transcript into React state.
The suite checks automatic loading to the latest messages, explicit cancellation,
single-page reads after cancellation, cancellation on session switch, automatic
tail alignment on reselection, the complete cursor chain past 100 pages, bounded mounted
messages/DOM, access to first and last items, paged multi-megabyte output,
streaming while typing, scroll anchoring, no full-history request on native turn
completion, scrolling through the complete history, and mobile layout.

Its ignored `receipts/long-thread/` manifest records the exact source, lockfile,
license and built-artifact hashes, browser version, fixture sizes, screenshot
checksums, import duration,
frame intervals, input-to-next-paint latency, and main-thread long tasks. It
rejects source changes during the run. During the streaming phase, p95 input
to next paint must remain below 100 ms (maximum 250 ms), p95 frame interval below
50 ms, and individual long tasks below 250 ms. Mounted transcript messages stay
at 200 (or every loaded message for shorter threads), regardless of loaded
history. All window messages contain readable text; rich Markdown is parsed near
the viewport to keep deep scrolling responsive. These are repeatable qualification
bounds on the recorded machine/browser, not a guarantee that every device or
arbitrary native payload can never pause. Native loading still requires network
round trips, and the current API makes reaching recent history in an existing
large thread an automatic, cancellable forward scan.

The long-thread suite also records renderer heap before and after forced garbage
collection, DOM counts, and serialized fixture bytes. Samples cover initial
history, full history, expanded output, scrolling/streaming, and switching to a
one-item session. `LEO_MEMORY_AUDIT_ONLY=1` records timing bounds as observations
while retaining functional assertions; its result is explicitly
`memory-audit-completed`, not a passing latency qualification. The default run
continues to enforce all timing thresholds. `LEO_HEAP_SNAPSHOT=1` additionally
writes a potentially large, local synthetic heap snapshot after switching.

After `npm run build`, `node scripts/gateway-memory-audit.mjs` measures the
published projection and personal HTTP surface in an isolated child process.
It forwards 100,000 synthetic history items and concurrent reads, then samples
live journal rotation, a stalled subscriber, and consumed replay retention.
The parent fixture/client allocations are outside the measured process. No
native provider or production gateway is contacted. Aggregate measurements and
checksums go to `receipts/gateway-memory/`. See [Memory audit](../../docs/Memory-Audit.md)
for the measured results, limitations, and follow-up priorities.

`node tests/browser/transcript-layout.mjs` checks the geometry of an 801-item
production-build fixture with varied Markdown and tool heights. It checks both
the first frame and settled layout after rapid scroll reversals, responsive
reflow, tool expansion and remounting, streamed output, and live/history item
reconciliation. Visible rows must not intersect or duplicate, and the transcript
must retain visible content with at most 200 mounted messages. Scrubbed passing
receipts and screenshot/source checksums live in `receipts/transcript-layout/`.

After `npm run build`, `node tests/browser/pwa.mjs` uses a disposable HTTP server
with the production assets and real service worker. It covers Android list home,
install metadata, static-only caching, cold offline text/image recovery, offline
camera input, autosave, explicit updates, invalid push rejection and expired auth.
No external push delivery or real model is used. `node tests/browser/durable-drafts.mjs`
uses real IndexedDB to check scopes, quota rejection, conflict preservation and
exact request/receipt recovery. Set `LEO_TEST_CHROMIUM` when Playwright's default
Chromium is unavailable. Physical Android installation, OS keyboard/camera
permissions and FCM background delivery remain operator device checks.
