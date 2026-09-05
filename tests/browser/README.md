# Browser qualification

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

Passing screenshots and a manifest covering all UI source, dependency lockfile,
font/license notices, and screenshot checksums are written under the ignored
`receipts/browser/` directory. Failed runs retain diagnostic screenshots only.
The suite rejects source changes during a run.
This qualifies browser behavior against disposable API fixtures; server Access
authentication, real runtime routing, and native Codex require their separate
integration suites.

`node tests/browser/long-thread.mjs` builds the production client into an
isolated receipt directory and opens a disposable 50,000-turn / 100,001-item
conversation. It uses the published oldest-first 100-item native paging
contract. No browser-only shortcuts inject the transcript into React state.
The suite checks initial bounded loading, explicit cancellation, cancellation
on session switch, the complete cursor chain past 100 pages, bounded mounted
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
large thread an explicit, cancellable forward scan.
