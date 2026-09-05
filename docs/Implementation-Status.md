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

The implementation passed application typechecking, 78 tests in eleven files, and
a production build. The cross-role mock test covers launch retry, metadata
authority, stop/resume, unavailable-source rejection, catalog reopening, and
archive release order. Authentication tests exercise signed HTTP/WS access and
expiry. Browser qualification covers six viewport screenshots and 15 checks,
with no serious or critical axe findings. These checks do not prove real-model
behavior through the new deployment.

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

The transcript uses an indexed store and measured virtual rows. Composer edits
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

Final UI verification passed all 78 tests, typechecking, production build, and
network-disabled Docker authentication/static-asset smoke checks. The viewport
suite passes 20 checks with populated transcripts, preserved per-agent drafts and
image previews, and exact-ID command reconciliation after a lost reply. All six
viewport screenshots were inspected; no serious or critical axe violations remain.

The production-build stress fixture loads 50,000 turns / 100,001 native items
through exactly 1,001 native pages. At most 17 messages were mounted. On the
qualification Chromium/machine, loading took 11.01 seconds, p95 input-to-next-paint
was 14.1 ms while streaming and 17.7 ms while simultaneously streaming, scrolling,
and typing (34.7 ms maximum). No main-thread long tasks were recorded in loading or
these interaction phases. A 2.2 MB output remains accessible through bounded parts.
These are measured fixture results, not an unlimited memory or every-device
latency guarantee; loaded native content still occupies memory and oldest-first
network paging determines how quickly recent history can be reached.

Final local receipts are `receipts/browser/2026-09-05T10-50-40.496Z` and
`receipts/long-thread/2026-09-05T10-50-03.478Z`. Their source/lockfile hashes match the
reviewed source. No production transcript or model interaction was used.
