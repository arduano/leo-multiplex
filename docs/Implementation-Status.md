# Implementation status — 2026-09-05

The personal host, gateway, UI, deployment packaging, and runbooks are implemented.
The NAS gateway is deployed at **http://100.82.173.47:8444/** through Tailscale
Serve. MagicDNS and HTTPS certificates are unnecessary for this IP route. The
operator's NixOS rebuild completed, and the permanent main-pc control and runtime
services are active. Initial runtime pairing is complete; enrollment is closed.
Cloudflare is postponed until the Tailscale trial works.
Existing Codex and tmux sessions have not been adopted, modified, or stopped.

## Implemented boundary

- Main-pc owns its canonical SQLite catalog, runtime journals, native Codex state,
  images, and managed terminals. The NAS gateway has no catalog authority.
- The personal existing-workdir provider applies full access and no approvals on
  launch and resume. Its private managed Codex home reuses the selected provider
  and auth-helper reference from the original read-only CLI configuration.
- The origin supports Tailscale Serve on an enforced host-loopback listener, or
  Cloudflare Access JWT verification. Both enforce owner email and mutation/WS
  origin. Tailscale identity headers from non-loopback socket peers are rejected.
- The personal React UI supports new managed sessions, native conversations,
  images, questions, model/mode controls, and terminals. Unavailable-host rows
  preserve drafts in browser memory while refusing stale actions.
- Nix exports the host package and Home Manager module. Docker Compose targets
  only `~/host/leo-multiplex` on home-nas. GitHub workflows check the application
  and publish a tested image on explicit workflow dispatch.

## Verification and its limits

The implementation passed application typechecking, 116 tests in thirteen files, and
a production build. The cross-role mock test covers launch retry, metadata
authority, stop/resume, unavailable-source rejection, catalog reopening, and
archive release order. Authentication tests exercise signed HTTP/WS access and
expiry. Browser qualification covers six viewports and the conversation regressions
described below, with no serious or critical axe findings. These checks do not
prove real-model behavior through the new deployment.

The Docker image passes a network-disabled smoke run using disposable signing
keys: built HTML/assets load, the gateway reports zero authority, and missing
authentication/configuration or a wrong origin fail closed. Production has no
fixture-key configuration. Compose and pinned GitHub workflows validate.

The Nix package builds with no unresolved ELF dependencies. Verification imports
Iroh, node-pty, transport, and host entrypoints, checks in-memory SQLite, and runs
only `leo-codex --version` (`0.152.0`). The public flake is pinned in main-pc's
dotfiles, and its full system build passed and was activated by the operator.
Existing unrelated dotfiles changes and dependency pins were preserved.

The public [Agent Multiplex v0.2.0 release](https://github.com/arduano/agent-multiplex/releases/tag/v0.2.0)
binds source `0e043478538a30a0a42fd854f5f5c8a14309cbf0`. Main CI, CodeQL,
deterministic tree/scale, and the approved real Codex/Copilot qualification passed.
The native run included a 930-second soak, fresh replies afterward, and complete
cleanup of its isolated resources. Its owner-recorded receipt inventory is
`79e7bfff5878448ef574f1d888024a8a11a000644eb8cb31bbb9f093a18ee077`.
[Publication run](https://github.com/arduano/agent-multiplex/actions/runs/33956925510)
passed. This framework qualification does not replace a personal deployment trial.

All 21 public assets match their release inventory. The 16 package tarballs have
different archive bytes from the local development packs but identical extracted
file contents. The app lock now records the public tarball integrities; a fresh
install downloads them without a registry token. Transport remains public 0.2.1.
There are no sibling imports or local file dependencies in deployment manifests.
The selected local-config TOML parser is pinned to patched version 1.6.1.

Passing browser manifests/screenshots and local implementation verification
inventories live in the ignored `receipts/` tree. Build and evaluation diagnostics
live in `.cache/`. Neither directory is published.

## NAS deployment verification

The NAS host has enough Docker interfaces to exceed automatic transport route
discovery's 32-address bound. The personal gateway now composes the published
source-client, projection, identity, and operational-store APIs with an explicit
Tailscale socket binding. The published framework and transport pins are unchanged.
Its process test covers offline HTTP availability, zero authority, reconnect,
stream reset, and clean shutdown.

The new Compose container is running with host-loopback HTTP and a Tailscale-bound
transport. Checks against the real NAS process passed health, owner authentication,
unauthenticated rejection, WebSocket upgrade, main-pc source selection, and
reconnection after control restart with enrollment closed. This used only the
new catalog service temporarily; no runtime or Codex session was launched. The
gateway retains its enrolled identity. Following permanent activation, runtime
enrollment was briefly opened on the new control and then closed again. Both
services remain active, and the gateway reports main-pc online and reachable
after the control restart with enrollment closed. The IP rollout additionally verifies authenticated browser and WebSocket access
through Tailscale Serve. Image draft IDs use secure browser randomness that is
available on an HTTP origin; browser qualification also disables the HTTPS-only
UUID/hash APIs while exercising attachments and stable launch requests.

The host code and Nix integration are unchanged from the public dotfiles pin
whose full system build passed. The UI now directly declares the same already
locked UUID dependency; no existing dependency version changed. The newer gateway-only revision does not require another host
build or repinning before the operator's prepared rebuild.

## Ready for the operator's first session

The first-boot offline status came from closed runtime enrollment: both Nix
services were running, but the control rejected the new runtime identity. Pairing
is now complete, and both enrollment flags are closed in the running service and
permanent configuration. The runtime was not restarted during pairing.

The real Tailscale browser path now loads main-pc in **New agent**, discovers 13
Codex models, and enables the launch form for an existing workdir. This check did
not submit a launch or send a prompt. Its local receipt is in
`receipts/host-pairing/2026-09-05T10-06-02.807Z`.

Open **http://100.82.173.47:8444/**, select **New agent**, choose main-pc and an
existing directory, then launch a Codex agent. The first managed session and
interactive trial are left to the operator. Existing CLI/tmux sessions remain
outside this application's ownership.

The IP route uses owner identity supplied by Tailscale Serve and encryption from
WireGuard. Its backend stays on NAS loopback. HTTPS/MagicDNS and Cloudflare can
be configured later; no unauthenticated LAN or public access is enabled.

## Personal conversation interface

The UI now uses a muted neutral/green palette, simple author labels, a compact
host rail, and details collapsed initially. Responsive sheets preserve the mounted
conversation, while per-binding drafts retain text, attached images, and uncertain
command envelopes in the same tab. Closing/reloading the page still clears these
in-memory drafts. Repeated submit events are guarded synchronously; an uncertain
command remains an explicit retry of its original ID after switching sessions.

The transcript uses an indexed store and a 200-message virtual window. Rich
Markdown and height measurements stay near the visible rows. Composer edits
and live deltas no longer merge, sort, or render all loaded history. Native events
are batched with bounded backpressure and a background-tab timer; diagnostics
retain summaries instead of serializing full native payloads. Long bodies render
one 16 KiB part at a time, preserving local Markdown image resolution and the
operator's tool expansion/part selection through virtual unmounts.

The pinned native API reads oldest-first pages of at most 100 items. Initial
opening reads one page; **Load to latest** scans forward incrementally and is
cancellable. Partial history is explicitly labelled, all cursors remain native,
and the former 100-page ceiling is gone. Turn completion no longer replays the
entire conversation. A stream gap reconciles from the loaded terminal cursor,
with additional pages exposed through the same loading controls.

The UI pass changes neither host code nor its Nix pin. A gateway/container update
leaves the running control, runtime, and managed Codex processes in place. Browser
and performance fixtures use only disposable intercepted APIs and no model calls.

Selecting a session now requests native history directly. The optional catalog
`nativeSummary` can be absent even when a launched Codex session already has
messages; it no longer prevents the initial read. A failed read shows an explicit
unavailable state with a retry control and retries at a native lifecycle boundary.
Once a page succeeds, ordinary turn completion does not replay loaded history.

The preceding history-loading UI verification passed all 78 tests, typechecking, and a production build.
The viewport suite passes 22 checks with populated transcripts, including initial
selection/reload without a catalog summary and recovery after unavailable initial
history. Per-agent drafts, images, and exact-ID uncertain-command reconciliation
remain covered. All six viewport screenshots were inspected; no serious or
critical axe violations remain.

That history-loading pass's production-build stress fixture loads 50,000 turns / 100,001 native items
through exactly 1,001 native pages. Exactly 200 messages are mounted once enough
history is loaded. On the qualification Chromium/machine, loading took 13.22
seconds; p95 input-to-next-paint was 13.5 ms while streaming and 16.0 ms while
simultaneously streaming, scrolling, and typing (20.1 ms maximum). Concurrent
frame interval p95 was 33.3 ms. No main-thread long tasks were recorded in loading
or these interaction phases. A 2.2 MB output remains accessible through bounded
parts. Loaded native content still occupies memory, and oldest-first network
paging determines how quickly recent history can be reached; these measurements
qualify this fixture and machine rather than guarantee every-device latency.

The history-loading pass's local receipts are `receipts/browser/2026-09-05T11-04-08.959Z` and
`receipts/long-thread/2026-09-05T11-06-34.700Z`. Their source/lockfile hashes match
that pass's reviewed source. Both use disposable fixtures with no model interaction. They
supersede the previous 17-row-window measurements. The operator's blank transcript
was separately diagnosed through a read-only native API request, recording only
aggregate status/counts.

The preceding history-loading rollout ran the tested image with local immutable identity
`sha256:60c281258852b662977387d8d3f4a3056534e80b1ab26e5bdfe7bf8ffc29cc75`,
built from UI source commit `bf130bb3cae38992df6d357f5cc66cfc2e35530a`.
[CI](https://github.com/arduano/leo-multiplex/actions/runs/33962543418) passed;
the image also passed local network-disabled authentication/static-asset smoke
checks. Only the `leo-multiplex-web` container was recreated.

Read-only checks through the Tailscale IP pass authentication, origin rejection,
static assets, reachable host projection, and a catalog WebSocket subscription.
The deployed asset bytes match the local production build. Browser checks now
also verify the operator's existing session actually loads: 81 native items
render after desktop selection, page reload, and mobile selection, with no
history or page errors. No prompts, launches, stops, archives, or model calls were
issued; no production transcript content or screenshots were recorded. The
control/runtime PIDs and process start times match their pre-deployment values.
Checksummed deployment evidence is
`receipts/history-window-deployment/2026-09-05T11-11-34.831Z`.

## Native error presentation

Native Codex `error` and failed `turn/completed` events now produce a dedicated
error notice and a persistent warning above the workspace. The warning separates
capacity, usage, rate, session-budget, context, and authentication failures using
native codes first, with explicit error-message wording as a fallback. Ordinary
assistant/tool content is never scanned to infer a provider failure. Native
messages and additional details render as plain text with bounded fields.

Notifications for the same native thread/turn update one notice. Native
`willRetry` is shown as an automatic retry already being performed by Codex;
the UI never retries the prompt or resumes the session automatically. A failed
completion keeps the earlier message if Codex omits its replacement error.
Root warnings survive switching sessions in the same tab and clear on observed
successful completion. Child errors remain separate transcript notices. Idle or
new-turn status alone does not erase an earlier failure. This is a bounded
observation cache in browser memory, not canonical state or browser storage.

The released `0.2.0` Codex history endpoint only pages thread items; it omits
past turn status/errors. A separate bounded native metadata read on selection
and reconciliation detects `systemError`, even when the catalog says idle. When
the original error message is unavailable, the UI explicitly directs the operator
to check Terminal before continuing, without claiming to know its cause. Exact
historical error recovery still needs a published framework route to native
`thread/turns/list` with `itemsView: "notLoaded"`; no such host change or restart
is included in this UI pass.

Typechecking and 116 tests in thirteen files pass. The disposable browser suite
passes 30 checks, including capacity/usage states, native retry/failure deduplication,
per-binding warning/draft retention, successful recovery, and reload with an idle
catalog but native systemError. Error-state screenshots across all six viewports
were inspected; no serious or critical axe findings remain. The local passing
browser receipt is `receipts/browser/2026-09-05T11-29-41.320Z`.

The new scale reruns are diagnostics, not passing qualification: under heavy
background CPU load, two runs reached the strict 50 ms p95 concurrent-frame
threshold (the later run measured 17.8 ms p95 / 27.5 ms maximum input-to-paint).
An attempt confined to eight busy CPUs failed the history-import long-task bound.
No performance threshold was relaxed and no unrelated process was stopped.
The preceding passing 200-message qualification remains historical evidence;
this error-presentation source has not received a new passing timing receipt.
The indexed store and 200-row window are preserved, and a unit check verifies
that normal live deltas do not notify the error banner/composer.

The native-error UI rollout used image
`sha256:ab2263cbb31c672432033bfa000d200967047835ab9b092244450db7df17d2ea`,
built from source `d1650bc20efa8893b2f64622f0f37a5ae1b1eeb4`.
[CI](https://github.com/arduano/leo-multiplex/actions/runs/33963795902) and local
production-build/container-smoke checks passed. Deployed assets match the local
build. Read-only browser verification shows all 81 existing native items and the
historical-error warning on selection, reload, and mobile. Authentication, origin
checks, host reachability, and the catalog WebSocket remain healthy. Only the
NAS web/gateway container was recreated; control/runtime PIDs and start times
are unchanged. No model calls or session mutations were issued. Checksummed
rollout evidence is `receipts/native-errors-deployment/2026-09-05T11-38-19.288Z`.

## Agent-facing CLI

`leo-agents` now exposes the personal gateway to shell tools and agent runners
such as OpenClaw. It is installed on main-pc at `~/.local/bin/leo-agents`, linked
to this checkout's built client. The default origin is the existing Tailscale IP;
owner authentication and gateway origin checks are unchanged. The client can
also read an existing Cloudflare assertion from a private file. Tagged Tailscale
machine identities remain unsupported by the current owner-login policy.

Commands cover host/session discovery, exact-profile launch, bounded native
history and NDJSON events, Codex turn waits, send/steer/interrupt, explicit
stop/resume, harness-native commands, pending interactions and explicit answers,
and scoped image upload/download. Every session mutation requires a caller-owned
request ID. The CLI commits its exact envelope in a private local ledger before
dispatch, reconciles repeated invocations, and resubmits only on an explicit
`operation REQUEST_ID --retry`. Uploads use caller-owned image IDs separately.

Send acknowledgment is distinct from turn completion. `send --wait` opens a
stream before dispatch and correlates the returned native Codex turn ID. Native
capacity/error, interruption, blocking input, missing continuity, and timeout
remain explicit outcomes. An idle catalog cannot bypass native `systemError`.
No command automatically resumes, approves a question, or retries a prompt.
Standalone waits require retained events to prove earlier completion; the pinned
history API's omission of old turn errors remains unchanged. The CLI and UI
share the existing pure native-error normalization module.

Typechecking, all 237 tests in eighteen files, and a production build pass.
Disposable subprocess HTTP/WS fixtures verify exact origin/auth headers, stdin,
completion-before-acknowledgment, capacity failure, initial stream gaps, timeout,
and immutable retries across process restarts. Focused tests cover private-ledger
races and filesystem checks, bounded observation, native response reconciliation,
and checksum-verified image transfer. No new model calls were used.

Read-only checks through the live Tailscale gateway pass host/session discovery,
native status and a bounded WebSocket subscription. The existing session still
reports idle in the catalog and `systemError` natively. Only aggregate status was
recorded. Control/runtime process IDs and start times are unchanged; no production
prompts, launches, stops, resumes, or image mutations were issued. No NAS deploy,
dotfiles change, or sudo rebuild is needed. The scrubbed, checksummed local receipt
is `receipts/agent-cli/2026-09-05T12-29-05.437Z`.

See [Agent CLI](Agent-CLI.md) for installation, JSON/exit semantics, recovery,
images, and an OpenClaw subprocess integration workflow.

## Composer commands and Codex model switching

The composer supports `/plan`, `/model`, `/effort`, `/mode`, `/default`,
`/interrupt`, `/new`, `/status`, `/terminal`, and `/help`, with native-mode
arguments and keyboard suggestions. Known and unsupported command tokens are
handled locally; they never accidentally become agent prompts. `//` escapes a
literal command. Attached images and unrelated message drafts survive setting
changes. An uncertain slash mutation retains its draft and exact command envelope
across session selection for explicit reconciliation.

The applied model is now the composer’s settings trigger. Model selection is a
single explicit action, followed by the Codex Reasoning tab. Reasoning levels and
descriptions come from the current model’s native catalog. The old hardcoded
reasoning list and separate draft/Apply controls are removed. Missing settings
remain unknown and catalog defaults are labelled separately. Retained effort
that is unsupported by a newly selected model gets a warning and an explicit
choice; the UI does not silently issue a second setting mutation.

Codex changes use native thread settings for subsequent turns. Copy makes this
scope explicit while work is running. Model/mode changes do not resume, prompt,
interrupt, or clear a capacity warning. Only `/interrupt` issues an interrupt;
`/new` opens the launch dialog without submitting it. See
[workspace commands](Workspace-Commands.md) for usage.

Typechecking, all 256 tests in nineteen files, and a production build pass.
The disposable browser suite passes 40 checks, including delayed setting
acknowledgment, failed and lost responses, exact retry identity, native reasoning
choices, image/draft retention, slash keyboard behavior, and mobile popup bounds.
All six viewport layouts and command/model panels were visually inspected;
no serious or critical axe findings remain. The receipt is
`receipts/browser/2026-09-05T12-55-29.177Z`.

The new production-build long-thread qualification passes on this machine with
50,000 turns / 100,001 native items and the 200-message window. Loading took
15.29 seconds. Concurrent streaming, scrolling, and typing measured 23.3 ms p95
input-to-paint (27.4 ms maximum), 33.4 ms p95 frame interval, and no long tasks.
Native data still occupies memory and oldest-first paging still determines
history loading time. This final-source receipt is
`receipts/long-thread/2026-09-05T12-56-59.005Z`.

The deployment container builds and passes isolated network-disabled
static-asset/authentication smoke tests. Runtime, control, provider, protocol,
Nix, and dotfiles code are unchanged. All development checks used disposable
state and no model calls.

The current NAS UI image is
`sha256:a8806b6ae9e3e61317db2b2777e9fcb436f6d2e55b917b138a52a0c8144381d6`,
built from source `a7e74e1372b0a10bc9ea6f75b5f2cb983b04a714`.
[CI](https://github.com/arduano/leo-multiplex/actions/runs/33967602801) passed,
including the container build and authentication/static-asset smoke tests.
The deployed JavaScript and CSS match the local production build byte for byte.
Read-only desktop and mobile checks show the native model and reasoning choices,
the slash menu, and all 81 existing history items on selection and reload. The
native-error warning remains visible. Host discovery and origin rejection pass.
Only the NAS web/gateway container was recreated; control/runtime process IDs
and start times are unchanged. No production setting changes, prompts, launches,
stops, resumes, or model calls were issued. No sudo rebuild is needed.
The scrubbed, checksummed rollout receipt is
`receipts/slash-commands-deployment/2026-09-05T13-01-00Z`.
