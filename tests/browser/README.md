# Browser qualification

Run `node tests/browser/qualify.mjs` after installing dependencies and a
Playwright-compatible Chromium browser. Set `LEO_TEST_CHROMIUM` to use an
existing browser executable.

The fixture starts a temporary loopback Vite server and intercepts all API and
WebSocket requests. It contacts no host, provider, Codex process, or auth home.
It verifies:

- Image attachment and stable launch construction with HTTPS-only UUID and hash
  APIs unavailable, as on a Tailscale HTTP origin.
- Six responsive viewports, visible composer, no document overflow, keyboard
  sheet dismissal/focus restoration, and no serious or critical axe findings.
- Stale host rows remain visible in browser memory with session and metadata
  drafts preserved; mutations stay disabled until recovery.
- Gateway reconnection and sign-in expiry retain the selected workspace.
- Lost launch responses, repeated submit events, dialog close/reopen, and retry
  retain exactly one launch ID and request body; terminal settlement unlocks
  the next launch.

Passing screenshots and a checksummed manifest are written under the ignored
`receipts/browser/` directory. Failed runs retain diagnostic screenshots only.
This qualifies browser behavior against disposable API fixtures; server Access
authentication, real runtime routing, and native Codex require their separate
integration suites.
