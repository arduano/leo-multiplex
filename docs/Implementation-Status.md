# Implementation status — 2026-09-06

## Installation handoff and gateway readiness

Laptop setup requires native x64 Node 24+ and Git, without comparing global npm
against the release toolchain. Standard `npm exec` fetches/caches the project's
npm for locked dependency installation with reviewed scripts; global npm stays
unchanged. Preflight does not invoke or download npm.

Installation revision **`0e79d73fc093f7a039694d9686b04c0b5be7c997`** passed
[exact-revision CI](https://github.com/arduano/leo-multiplex/actions/runs/34025984889),
including 435 application tests, container authentication/proxy checks, both
PowerShell wrappers and actual published Windows installation with global npm
**11.15.0 and 12.0.2**. Both jobs installed on disposable D: state, verified the
saved launcher/rerun and unchanged global npm, then passed native host/restart
and C:/D: work-command checks. No model calls or corporate login were used.
All four native receipt inventories were independently rehashed under
`receipts/published-windows/0e79d73-exact/`. The public-source installer also
passed on Linux with WSL detection, with independently rehashed evidence at
`receipts/wsl-published-install/2026-09-06T09-56-59.077Z/`.

The [installer gist](https://gist.github.com/arduano/13b94161cb7ebfb054a2d4629b764aa5)
pins that tested installation revision; all three files were read back and
verified. Its commands use fresh Windows/WSL source directories to preserve
checkouts from older failed preflights. Corporate auth/network and physical
laptop UAT remain. Documentation-only follow-ups do not change the gist pin.

The work-host installers now pin all 16 published framework `0.2.1` artifacts,
with exact URLs, overrides and locked integrities. The signed release completed
[publication](https://github.com/arduano/agent-multiplex/actions/runs/34023552031)
after exact-main CI, CodeQL, deterministic Docker, Windows startup and the
owner-authorized five-minute live native soak. It does not requalify the
15-minute transport renewal boundary. Existing installed personal host services
and native sessions were preserved.

The new published Windows CI verifies the release inventory and executes the
actual installer on disposable `D:` state, saved launcher help, secret-copy and
rerun behavior, then host/executor checks across C:/D:. It uses no source overlay,
corporate credentials or model calls. The
[installer gist](https://gist.github.com/arduano/13b94161cb7ebfb054a2d4629b764aa5)
owns the final tested installation revision and workflow links; use that exact
revision for installation. Corporate OAuth/network/share/suspend behavior
remains laptop UAT. Windows uses a static unrestricted personal path policy;
optional workspace arguments opt into narrower roots.

Earlier candidate/install-blocker notes below are historical evidence, superseded
by the current published pin and Windows runbook. Deployment state is separate:
main-pc and NAS keep their existing installed graph and session state.

The NAS gateway now has **main-pc, home-nas and work-windows** configured and
online. Windows exposes the corporate Copilot harness and `copilot-workspace`
launch profile; read-only model discovery returned 21 models. Its separate
work-command endpoint is enrolled and available, with harmless PowerShell marker
commands completing from both C:/ and D: with exit 0. The owner still needs to
restart the Windows foreground host with plain `start` to close enrollment.
No native agent session or model prompt was created during enrollment.

First work-target startup exposed an omitted gateway bind setting: recovery
transport advertised the NAS's many Docker interfaces and failed its address
limit. Source **`83d53d07b994b62666ea928778e1a09110102b6d`** passes
`LEO_GATEWAY_P2P_BIND` to both transports. The deployed image is
`sha256:9b734c2df4d9c1d45309948f2c4e1c69fabe56c07ec60c0764752bf0e38e4872`.
Typecheck/build, 435 application tests, three new composition regression cases,
shipped-container authentication and Compose DNS/socket/WebSocket checks pass.
Two timing-sensitive tests failed during a concurrent Docker build; the full
suite passed with four workers. Deployment evidence is scrubbed/checksummed at
`receipts/windows-enrollment/2026-09-06T10-20-14Z/`. Tailscale is healthy,
Cloudflare redirects unsigned requests to Access, and personal control/runtime
PIDs and start times remain unchanged. Previous image/configuration pins are
backed up privately on NAS under `backups/windows-enrollment-20260906/`.

Known CLI follow-up: `models` and `launch` still select the Codex `workspace`
profile for Copilot; web selects `copilot-workspace` correctly. This does not
affect `exec` or web model discovery/creation. Corporate prompt/suspend UAT and
WSL installation remain pending. The installer gist keeps its previously tested
revision; this gateway fix requires no laptop reinstallation.

The existing user `leo-agents` links on main-pc and NAS now use the tested
work-command CLI. Their previous source checkouts and local operation ledgers
remain in place; read-only host and command-target queries pass on both.

## Work laptop command candidate

The Windows/WSL installers now enable a bespoke command recovery sidecar. The
normal interface is `leo-agents exec`, with `exec-hosts`, `exec-status` and
`exec-cancel`; web keeps a separate experimental App settings hatch. The service
starts before Copilot doctor/runtime and can remain available when those fail.
Only these installed work profiles publish command targets. Generic Multiplex,
personal Codex hosts and the exact published dependency graph are unchanged.

Commands use a separate pinned application protocol and host-owned private
journal, with durable admission/deduplication, one active command per host,
bounded output/time and explicit cancellation. Local CLI/browser state saves the
immutable target/request before submission. A restarted in-flight command becomes
`outcomeUnknown` and requires local process inspection before new admission.
The [work-command runbook](Work-Host-Commands.md) owns usage, pairing and recovery.

The gateway is deployed as recorded above; work-host installation and corporate
laptop UAT remain pending. Native Windows installation requires the framework's
public Windows ACL release. Windows CI checks the exact PowerShell/process-job
wrapper independently of framework overlays, and the full source-candidate
host/executor smoke now also passes. No model call or native session mutation
was used.

The candidate passes typechecking, all 420 application tests, production/container
builds, shipped-container authentication/static-asset checks, and the Compose
DNS/Unix-socket/WebSocket authentication regression. Focused tests include an
authenticated HTTP → real Iroh → real disposable Bash execution with exact-ID
deduplication, plus crash recovery and failure-isolated Copilot startup. The WSL
wrapper suite passes its 14 cases. Browser evidence passes eight work-command
groups across six viewports at
`receipts/work-command-browser/2026-09-06T06-38-11.473Z`, 70 general checks at
`receipts/browser/2026-09-06T06-37-57.002Z`, and 11 durable-draft checks at
`receipts/durable-drafts/2026-09-06T06-37-13.290Z`. Source and screenshot checksums
were independently verified; there were no serious or critical axe findings.

## Windows and WSL installer candidate

The [Windows PowerShell installer](../deploy/windows/install.ps1) and
[WSL Bash installer](../deploy/wsl/install.sh) prepare corporate Copilot hosts
named `work-windows` and `work-wsl`. They use separate private state, native
account bindings, saved configuration and ports. Personal Codex remains on the
existing hosts. The [laptop runbook](Laptop-Hosts.md) owns installation, first
enrollment, preserving existing NAS sources and the physical-device checks.

Setup requires an explicit clean source revision, public artifact integrity,
and native x64 Node/Git. The earlier exact global npm requirement is superseded
by the cached install tool described above. Working directories must exist
when selected for an agent or command; workspace restrictions are optional.
It imports the fleet credential by file path and creates a persistent launcher;
login and foreground startup are separate commands. Exact reruns preserve state,
conflicting configuration/credentials are rejected, and enrollment remains closed
unless the operator explicitly starts with `--enroll`. No global tool, execution
policy, firewall, scheduled task or installed personal service is changed.

The published framework pin remains `0.2.0`; native Windows installation rejects
that graph before dependencies or state are written. These scripts do not bypass
the release gate using a source overlay. WSL uses the Linux packages, while both
hosts still need corporate auth/network/laptop UAT. The installer branch also
contains the already deployed multi-host session fixes. Its gateway composition
is deployed as recorded above; installed personal host services remain unchanged.

Local typecheck, all 378 tests and the production build pass, including 25
installer tests for private state, same-revision reruns, active-writer refusal,
source drift, account/environment isolation and graceful console shutdown.
The standalone shell suite passes 14 WSL wrapper cases and includes native
Windows PowerShell/PowerShell cases in CI, without installing model dependencies.
Combined browser evidence passes 70 checks at
`receipts/browser/2026-09-06T05-31-44.699Z` and 14 four-host checks at
`receipts/browser-multi-host/2026-09-06T05-29-17.537Z`. The merge's browser fixtures
now use distinct NAS/Windows runtime IDs. No model calls or corporate credentials
were used, and no installed host or existing session was changed.

## Corporate Copilot candidate

The Windows x64 Copilot path is prepared on `copilot-windows-host`, with
[personal PR #1](https://github.com/arduano/leo-multiplex/pull/1) and
[framework PR #22](https://github.com/arduano/agent-multiplex/pull/22). It adds a
separate native Copilot home/profile, corporate GitHub OAuth account binding,
local init/login/doctor/start commands, private fleet pairing/merge, and native
Copilot model/mode creation controls. The account binding rejects a switched
identity or ambient `gh` fallback; no Codex LB configuration is read or copied.
The Copilot default state directory is `leo-multiplex-copilot`, keeping it
separate from the installed Codex host even on Linux.

The consumer keeps its published framework `0.2.0` pin and refuses native Windows
state initialization without the framework ACL update. Framework source now has
passing native Windows tests for protected DACLs, SQLite writer ownership/reopen,
retained image uploads, Iroh startup and unauthenticated Copilot SDK startup.
The complete personal control/runtime Windows lifecycle also passes
[the native Windows run](https://github.com/arduano/agent-multiplex/actions/runs/34011570520)
for framework `96e2d3e165d7448dbf9cca41658a8467893fd5e7` and consumer
`b1b31996f1dff9eba024d14491258c081dd6db1d`, including registration, graceful
shutdown and a restart with enrollment closed. Its consumer receipt SHA-256 is
`00a1e8dbc7d3d3db93adbb5d43e3176568a6b4f90f501104fb3fc4f87e59d9c6`;
the framework startup receipt SHA-256 is
`fdf3eece8ef55ab4d4fa28c2870a048d7c788fa814346681ded909b7f1ea0a2a`.
Both downloaded receipt inventories were independently rehashed. Earlier failed
Windows runs remain diagnostics, including the loopback-only P2P bind attempt;
the passing composition uses the host's default all-interface P2P bind. These
are source-candidate checks, not a published-release or corporate-laptop claim;
the [Windows runbook](../deploy/windows/README.md) owns installation readiness,
pairing, local diagnostics and remaining laptop acceptance checks.

Personal validation passes typecheck/build, 346 tests, and CI including Docker
authentication checks. The Copilot launch browser fixture passes 64 checks across
six viewports, including native profile/model/mode input and Windows paths, at
`receipts/browser/2026-09-06T04-07-21.977Z`; that receipt qualifies its recorded UI
source, before later host-only account/ACL work and notice updates. Framework
validation passes its 607 tests, typecheck, checkpoint, docs/release checks and
workflow lint. Source-candidate CI overlays never change deployment manifests or
stand in for published artifacts. No installed host, gateway, native session,
corporate login or model prompt was changed by this work.

Before a native Windows installation handoff, publish/qualify the framework patch and
pin its exact public artifacts here. That release process requires a fresh
allowance for model-using native qualification. Windows image-path previews
remain explicitly unsupported, and managed-laptop OAuth/SSO, network policy,
sleep/reconnect and real prompt behavior remain physical-device UAT.

The personal host, gateway, UI, deployment packaging, and runbooks are implemented.
The NAS gateway is deployed at **https://agents.arduano.io/** through Cloudflare
Access and at **http://100.82.173.47:8444/** through Tailscale Serve. MagicDNS and
HTTPS certificates are unnecessary for the IP route. The
operator's NixOS rebuild completed, and the permanent main-pc control and runtime
services are active. Initial runtime pairing is complete; enrollment is closed.
Both access paths share the existing gateway identity and host connection.
Existing Codex and tmux sessions have not been adopted, modified, or stopped.

## Implemented boundary

- Main-pc owns its canonical SQLite catalog, runtime journals, native Codex state,
  images, and managed terminals. The NAS gateway has no catalog authority.
- The personal existing-workdir provider applies full access and no approvals on
  launch and resume. Its private managed Codex home reuses the selected provider
  and auth-helper reference from the original read-only CLI configuration.
- The origin supports Tailscale Serve on an enforced host-loopback listener and
  separately configured Cloudflare Access JWT verification. Both enforce owner email and mutation/WS
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
native recovery, as corrected below. Child errors remain separate transcript
notices. Idle alone does not erase an earlier failure. This is a bounded
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

The slash-command UI rollout used image
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

## Error banner recovery correction

The previous warning cache deliberately retained a failed turn's banner until a
later turn completed successfully. A follow-up could therefore be working in
Terminal while the web workspace still claimed it had stopped with an error;
refreshing discarded the stale observation.

The banner now clears when Codex starts a new root turn. Native active-status
reads also reconcile a cached terminal failure when selection missed the start;
the old turn fence is discarded so failures from the new turn remain visible.
Native assistant, plan, or reasoning output clears an automatic-retry warning
when the provider recovers. Idle, settings changes, and command acknowledgments
do not clear failures. Root/child, sequence, and generation fences prevent stale
events or delayed reads from reviving the old warning. Existing transcript error
notices remain, and any later native failure produces a fresh warning.

Typechecking, all 264 tests in nineteen files, the production build, and isolated
container authentication/static-asset smoke checks pass. Browser qualification
passes 41 checks with the six viewport layouts inspected and no serious or
critical accessibility findings. It covers recovery before turn completion,
preserved transcript failures, a subsequent error, and recovery after navigation
missed the native start. The final-source browser receipt is
`receipts/browser/2026-09-05T13-38-54.421Z`.
The change does not scan history or notify the composer for ordinary deltas;
unit checks exercise 1,000 subsequent deltas for each recovery-output type.

The error-recovery rollout used image
`sha256:d54a915600db42dfac45d0cd556529eb9eba3e60ed1d2b4a0781e9e5e931090d`,
built from source `b61cb5ea7309bce6bbe125d485c881783c8e56c8`.
[CI](https://github.com/arduano/leo-multiplex/actions/runs/33969617759) passed.
Deployed assets match the tested production build. Read-only desktop, reload,
and mobile checks show 100 native items and an active native session without a
stale error banner. Only the web/gateway container was recreated; host control
and runtime process identities are unchanged. No production mutations or model
calls were issued. Checksummed rollout evidence is
`receipts/error-recovery-deployment/2026-09-05T13-43-00Z`.

## Transcript layout and working indicator

The previous virtual window positioned each row independently from cached
heights, while some rows stopped measurement and switched between Markdown and
plain text. A disposable reproduction found eleven painted overlapping row
pairs during a large scroll reversal. The window now has one positioned parent
with its rows in normal document flow; height changes move neighboring rows in
the same layout. All mounted rows are observed for size changes. Deferred
offscreen rendering remains, with at most 200 readable messages mounted.

Responsive shell changes also detached and reattached the preserved conversation
portal, resetting browser scrolling while leaving the virtualizer at its old
offset. The shell now restores the transcript offset and synchronizes the scroll
observer across reparenting. Session state and drafts stay mounted.

A small “Working…” indicator appears below the newest loaded message while the
selected reachable agent is running. Native error warnings take precedence;
idle, failed, and offline agents do not show it. Reduced-motion preferences
disable the dot's pulse.

Typechecking, all 264 tests, the production build, and isolated container smoke
checks pass. Browser qualification passes 45 checks, including desktop/mobile
indicator placement and its lifecycle. The separate transcript fixture passes
121 geometry checks covering immediate and settled scroll reversals, all six
viewport sizes, tool expansion/remounting, streamed output, and native-history
reconciliation. Visibility checks exclude content the browser explicitly skips
painting; the corrected checks still reproduce the old overlap. Screenshot
reviews found no clipping, overlap, or serious/critical accessibility findings.
Final-source receipts are `receipts/browser/2026-09-05T14-03-45.097Z` and
`receipts/transcript-layout/2026-09-05T14-01-42.519Z`.

The final-source 50,000-turn / 100,001-item stress test passes with the
200-message window: simultaneous scrolling/streaming/typing measured 26.6 ms
p95 input-to-paint (90.4 ms maximum), 33.4 ms p95 frame interval, and no long
tasks. Full history loading took 28.10 seconds on this run. The checksummed
artifact manifest is `receipts/long-thread/2026-09-05T14-04-44.017Z`.

The transcript-layout rollout used image
`sha256:e22446b199de3537b9d9293813189e513dbb6ab2c3e00d45bf69b68e7c9bd75b`,
built from source `d686eb7d36333b6746ca3c6349afbdf0b11401b7`.
[CI](https://github.com/arduano/leo-multiplex/actions/runs/33970820485) passed.
Deployed entry and dynamic JavaScript/CSS assets match the tested build.
Read-only desktop, reload, and mobile checks show native active work, the bottom
working indicator, and no stale error banner or history/page errors. Host
reachability and Origin rejection pass. Only the NAS web/gateway container was
recreated; control/runtime process IDs and start times remain unchanged. No
production mutations or model calls were issued. Checksummed rollout evidence is
`receipts/transcript-layout-deployment/2026-09-05T14-07-00Z`.

## Open sessions at their latest messages

Selecting or reloading a session now automatically follows bounded native pages
to the end, instead of stopping after the first 100 oldest items. The history
bar shows “Loading latest messages…” and keeps cancellation available. After
stopping, the existing single-page and load-to-latest controls remain usable.
Switching sessions cancels the old binding's request; ordinary completed turns
still do not reread loaded history.

The viewport follows the newest messages throughout loading. Wheel, touch,
scrollbar, and keyboard gestures can move the reader away; native page growth,
image measurement, or responsive layout scroll events alone cannot disable
follow-to-latest. Reading earlier content preserves its anchor while new data
arrives. Published dependencies and host/runtime behavior are unchanged.

Typechecking, 264 tests, the production build, and the isolated container smoke
checks pass. The browser suite passes 45 checks, and the geometry fixture passes
124 checks including automatic final-message visibility after native/live
reconciliation. All six viewport screenshots were inspected. Receipts are
`receipts/browser/2026-09-05T23-49-08.973Z` and
`receipts/transcript-layout/2026-09-05T23-49-10.111Z`.

The 50,000-turn / 100,001-item suite automatically reaches the final message
through all 1,001 native pages without a load button click and keeps at most 200
messages mounted. This run took 45.97 seconds; typing during import measured
21.9 ms p95 input-to-paint. Simultaneous streaming, scrolling, and typing measured
27.5 ms p95 (40.3 ms maximum), 33.3 ms p95 frame interval, and no long tasks.
Cancellation, explicit single-page reads, switching away, and reselection pass.
The final-source receipt is `receipts/long-thread/2026-09-05T23-50-02.865Z`.

The preceding NAS UI image was
`sha256:755d0a5ebbfc8b432a54d0a3b6e102f05739290c57b34d2400398bc3a268c75a`,
built from source `0db7ad957365446d20bf0d68b9197ca18a7064b6`.
[CI](https://github.com/arduano/leo-multiplex/actions/runs/33999804190) passed.
Deployed entry and dynamic assets match the tested build. Read-only checks on the
existing session pass desktop selection, reload, and mobile selection with
complete history and the viewport at the latest messages. No history/page errors
or production mutations occurred. Host control/runtime process identities are
unchanged; only the web/gateway container was recreated. Checksummed rollout evidence is
`receipts/latest-history-deployment/2026-09-05T23-54-00Z`.

## Separate native threads and stable scrolling

Codex descendants share the logical session's event stream, but now have
independent transcript stores. Chat shows the parent; the Subagents tab selects
a named child and its own messages, tools, and errors. Native thread, turn, and
item IDs jointly identify rows. A child's prompt echo cannot acknowledge a
parent draft, and child lifecycle events cannot trigger parent history recovery.
Child selection is for observation; the parent composer remains in Chat.

The published host API exposes only parent history. The child view therefore
explicitly labels its content as partial activity received while this session
is open; connection gaps remain visible and invalidate observed child status.
No vendor history files, extra native connections, or host changes provide an
alternate history source. A search bounds the child selector after 100 agents.

Paginated item history supplies neither completion state for assistant messages
nor a native event watermark. The UI no longer treats message phase as completion
or appends an ambiguous live suffix to a history snapshot. It retains a separate
stream prefix: a stream observed from item start resumes displaying when it
catches up with the snapshot, and item completion supplies the final replacement.
If selection missed the start, that one ambiguous message may retain its snapshot
until completion. New messages stream normally. This preserves native text
without guessing replay overlap.

Rows retain Markdown once rendered while mounted, and resize corrections are
committed as one batch before paint. An upward gesture leaves latest-follow
even inside the near-bottom threshold; a later downward gesture can resume it.
Reduced-motion styling disables transitions instead of assigning a small
nonzero duration to every element: that rule accidentally animated virtual
positions and produced alternating one-frame jumps. Transcript positions also
explicitly opt out of transitions.
The 200-message window, natural-flow layout, native pagination, and bounded body
parts remain in use.

Typechecking, 277 tests, the production build, and isolated container smoke
checks pass. Browser qualification passes 48 checks, including child output/error
isolation and desktop/mobile child views. The layout suite passes 126 checks,
including 360 frame samples and upward scrolling while new output arrives.
All six viewport screenshots were inspected. Source-matched receipts are
`receipts/browser/2026-09-06T00-25-39.783Z` and
`receipts/transcript-layout/2026-09-06T00-25-02.526Z`.

The final-source 50,000-turn / 100,001-item stress run passes with 200 messages
mounted. Automatic import took 39.70 seconds; import input-to-paint p95 was
11.1 ms, with no task above 65 ms. Concurrent scrolling, streaming, and typing
measured 12.8 ms p95 input-to-paint (31.7 ms maximum) and 33.4 ms p95 frame
interval. The passing receipt is
`receipts/long-thread/2026-09-06T00-32-44.376Z`. An earlier run overlapping image
transfer failed the import-task bound; a profiled run and the ordinary rerun
passed with identical source hashes. Timings qualify the recorded machine and
workload; no thresholds were relaxed or unrelated agents stopped.

That rollout used NAS UI image
`sha256:0b13337b82ea7cc06c0e1d39f82b3ffe941958bea3800439b6462fe1105d1a9f`,
built from source `f1c63f3afc671b239e123b2bcb9cdf2242235cb7`.
[CI](https://github.com/arduano/leo-multiplex/actions/runs/34001367380) passed.
Deployed entry/dynamic assets match the tested build. Read-only desktop, reload,
mobile, and return-from-subagent checks load all 519 parent items, mount 200,
show only the parent thread in Chat, and reach the latest messages without
errors. The Subagents view labels partial history and has no parent composer.
Only the NAS web/gateway container was recreated; control/runtime process IDs
and start times are unchanged. No native session mutations or model calls were
issued. Checksummed rollout evidence is
`receipts/thread-scroll-deployment/2026-09-06T00-34-00Z`.

## Cloudflare deployment — 2026-09-06

The public route **https://agents.arduano.io/** is connected through the owner's
existing Access application and a dedicated cloudflared container in
`~/host/leo-multiplex` on NAS. Compose service-name DNS preserves the configured
origin `http://multiplex-gatreway:8444`. That small Nginx origin forwards to an
owner-only Unix socket on the existing gateway, with separate Cloudflare JWT
validation. The Tailscale listener, URL, CLI, enrolled gateway identity, state,
and explicit P2P bind remain in use. Host control/runtime process IDs and start
times are unchanged; no host rebuild or native agent mutation was performed.

Use `compose.cloudflare.yaml` for future updates. The NAS exhausted Docker's
default subnet pools; the isolated project bridge uses the verified unused
`10.203.82.0/24`, with dynamic container addresses and normal service-name DNS.
The first Compose attempt failed before replacing the running gateway; the
successful retry added only this project's network and containers. The prior
environment is preserved privately as `.env.before-cloudflare` for rollback.
See the [NAS runbook](../deploy/nas/README.md#cloudflare-and-tailscale-together).

The initial Cloudflare rollout used Leo image
`sha256:d21b2758612f8eff66e183d1f24f5d818e36251e4733e46efc005f12ffde1cb7`.
Typecheck, all 302 tests, production build, shipped-image smoke and the pinned
Docker proxy test passed. The proxy test exercises actual Compose-name DNS,
Unix HTTP, built assets, JWT/Tailscale isolation, mutation origins, WebSocket
upgrades and expiration while the Tailscale connection remains active. CI now
runs that proxy regression. All signing keys in tests are disposable; production
has no fixture-key configuration.

Live checks confirm the connector is ready, its configured public hostname and
upstream match, both gateway/proxy health checks pass, unsigned/forged-Tailscale
requests to the Cloudflare origin fail, and the original CLI reports main-pc
online and reachable. The public UI and API paths redirect anonymous requests
to the owner's Access login. The operator's interactive Access login remains a
manual final browser check; no real owner JWT was obtained or retained during
deployment. The tunnel token and Unix socket are both 0600 in private directories.

Source `82da0c3121511c0bbf25b31d9afd123383457cee` passed
[CI](https://github.com/arduano/leo-multiplex/actions/runs/34003128645), including
the new Docker proxy regression. Deployed server modules match the tested local
build byte-for-byte. The original Tailscale WebSocket upgrade and read-only CLI
host/session queries also passed. Scrubbed, checksummed deployment evidence is
`receipts/cloudflare-deployment/2026-09-06T01-10-00Z`.

## Compact execution and memory audit — 2026-09-06

Empty reasoning keeps its native identity and replay state without occupying a
display row. Disclosed summaries, images, and failures remain visible; reasoning
that later receives text appears in its original native position. Tools without
output show their title and status without an empty disclosure or “No output”.
Collapsed desktop execution rows now occupy 44 px instead of 68 px, while coarse
pointer disclosures retain a 44 px touch target. The 200-row window and existing
scroll protections remain in place.

Typechecking, all 306 tests, production build, and shipped-container smoke pass.
Browser qualification passes 56 checks across six viewports, including compact
execution and keyboard/touch disclosure checks, with no serious or critical axe
findings. The layout suite passes 126 checks and 360 scroll samples. Receipts:
`receipts/browser/2026-09-06T01-27-18.477Z` and
`receipts/transcript-layout/2026-09-06T01-26-19.913Z`. The full unit suite needed a
sequential rerun under heavy host load; that rerun passed. An exploratory full
coarse-pointer viewport run also exposed an existing short-landscape capacity
banner height issue; the scoped compact disclosure touch check passes.

The [memory audit](Memory-Audit.md) records a 50,000-turn browser fixture and an
isolated gateway history/live-event workload. The browser retains full loaded
transcripts and cached closures keep a previous thread reachable after switching.
Gateway history forwarding is uncached, but live buffers are count-bounded and
consumed replay references remain retained by active subscriptions. These are
documented follow-ups, not fixes claimed by this UI pass. No native session
mutation or model call was used.

The new 50,000-turn runs provide memory measurements and functional checks, not
a fresh latency qualification: strict import timing failed under substantial
background CPU load. Audit mode explicitly labels timings as observations and
leaves the default thresholds unchanged. The earlier successful timing receipt
above applies only to its recorded source and environment.

The NAS UI now runs image
`sha256:456c4ba18cf5adb80984a20663ba82129fb2f3b0de7d47036da9309e1b3758bd`
from source `f16468f597079ab308539d866ba5e2add3ccbc3c`.
[CI](https://github.com/arduano/leo-multiplex/actions/runs/34004585037) passed,
including the Docker proxy/authentication regression. Only the web container
was recreated through `compose.cloudflare.yaml`; its prior environment is
preserved privately as `.env.before-compact-ui`. Host service IDs and start times
are unchanged. Both origin health checks, connector readiness, public Access
redirects, Tailscale CLI queries and a catalog WebSocket subscription pass.
All served entry/dynamic assets match the tested local build; both source and
browser/layout receipt hashes were checked. Scrubbed, checksummed deployment
evidence is `receipts/compact-ui-deployment/2026-09-06T01-45-05.295666+00-00`.

## Android PWA — 2026-09-06

The personal UI now includes an installable Android/Chrome shell, agent-list home,
watched/input/working filters, phone Back navigation, visible-keyboard sizing,
camera/gallery attachments, zoomable images and terminal touch controls.
Text/image drafts and exact pending operations are durable device-local IndexedDB
state. This supersedes the older memory-only draft description above. Offline
launch exposes saved work only; native history stays in the existing bounded
in-memory cache. Service-worker caches contain only static build assets and an
anonymous shell; app updates wait for explicit save/activation.

Watched-only title/status push is composed in the personal gateway from its
already accepted native stream. Device registration, categories and revocation
use the existing authenticated origin checks. Private VAPID/subscription/watch
state lives in the existing NAS gateway state volume. The [Android runbook](Mobile-PWA.md)
owns installation, draft recovery, notification behavior and device-test limits.
Framework dependencies, the 200-message virtual window, and the accepted browser
cache memory/TTL tradeoff are unchanged. No host rebuild is required.

This source passes typechecking, 335 tests, production build, shipped-container
smoke, and the Compose DNS/Unix-socket authentication regression. Browser
qualification passes 57 checks and 32 screenshots across the six desktop/tablet/
phone viewports, with no serious or critical axe violations. The production PWA
suite passes seven checks with real service-worker/IndexedDB behavior and a
mocked PushManager for registration controls. The layout suite passes 126 checks
and 360 scroll samples. Local receipts are:
`receipts/browser/2026-09-06T02-56-42.104Z`,
`receipts/pwa/2026-09-06T02-57-52.028Z`,
`receipts/transcript-layout/2026-09-06T02-58-06.492Z`.

The new strict 50,000-turn / 100,001-item qualification passes unchanged latency
bounds. Initial oldest-first loading took 41.2 seconds under the recorded host
load. Concurrent scrolling/streaming/typing measured 15.3 ms p95 input-to-paint
(27 ms maximum) and 33.3 ms p95 frame interval, with no long tasks during that
interaction phase. Retained heap after switching was 73.2 MB decimal, consistent
with the accepted cache tradeoff. This qualifies the recorded synthetic Chromium
fixture, not arbitrary payloads or physical-phone latency. Its receipt is
`receipts/long-thread/2026-09-06T02-56-56.596Z`.

The final cleanup makes empty-record deletion atomic across browser tabs. Final
source `f309ffd64f621958b2ccfa7562bbbd581bd0d590` passed
[CI](https://github.com/arduano/leo-multiplex/actions/runs/34008128181) and runs on
NAS as image
`sha256:cb14da65a28746386e38bf92c637f7e2b87d5ed30e08a45e8172df98b30e9982`.
Its source-matched browser, PWA, durable-draft and layout receipts are
`receipts/browser/2026-09-06T03-04-13.690Z`,
`receipts/pwa/2026-09-06T03-04-34.982Z`,
`receipts/durable-drafts/2026-09-06T03-04-13.762Z` (11 checks), and
`receipts/transcript-layout/2026-09-06T03-05-07.902Z`.
The final 50,000-turn run passes at
`receipts/long-thread/2026-09-06T03-06-27.668Z`: 37.1-second import, 14 ms p95
concurrent input-to-paint (24.4 ms maximum), 33.3 ms p95 frame interval and
73.1 MB decimal retained heap. A preceding concurrent run exceeded the import
long-task bound and remains diagnostic evidence; the isolated rerun used
unchanged thresholds and did not stop unrelated work.

Only the NAS web/gateway container was recreated through
`compose.cloudflare.yaml`. The private `.env.before-pwa` backup retains the
previous deployment reference. Both listener health checks, Cloudflare Access
redirects (including SW/manifest/mobile routes), owner-only socket/VAPID state,
Tailscale mobile API, host reachability, and read-only catalog WebSocket pass.
Served assets and compiled server modules match the tested image/build exactly.
Main-pc control/runtime PIDs and process start times are unchanged; no production
session mutation, model call or host rebuild occurred. Final scrubbed,
checksummed deployment evidence is
`receipts/pwa-deployment/2026-09-06T03-08-02.078598+00-00`.
Physical Android installation, OS keyboard/camera behavior and external FCM
background delivery remain the operator's device check.

## Managed Codex update — 2026-09-06

The personal Nix host now pins Codex CLI 0.153.4 using the npm release's exact
SHA-512 integrity. This is the latest stable release on the
[official changelog](https://developers.openai.com/codex/changelog/) and npm's
`latest` tag at verification time; 0.154 prereleases are excluded. The ordinary
CLI on main-pc and home-nas was already 0.153.4, while their separately packaged
managed app servers still ran 0.152.0.

The published framework adapter stays at 0.2.0. Its packaged compatibility
metadata still describes the framework's 0.152.0 release baseline; executable
`--version` and running process paths determine the personal host's installed
Codex version. Isolated native checks against both the ordinary and Nix-patched
0.153.4 executable pass initialization, model/mode catalogs, empty-thread creation,
metadata reads, acknowledged mode/effort changes and shutdown through the released
adapter. No prompt/model call or production thread was used for these checks.
The Nix binary receipt is `receipts/codex-upgrade/2026-09-06T03-25-04.128Z`.

Main-pc and home-nas now run managed Codex **0.153.4**. The published pin is
`72e08a710dd82022b8c76c68ae69c1bff05e4f80`, with passing
[CI](https://github.com/arduano/leo-multiplex/actions/runs/34008995173),
335 tests, typechecking and Nix package/unit builds. Both local dotfiles checkouts
pin that revision; only the Leo input/lock changed. NAS's existing runtime
Tailscale bind override and provider preparation remain intact.

Only each generated `leo-runtime.service` unit was installed and restarted;
control catalogs and the NAS web/gateway stayed running. Native/runtime state
was copied privately after its writers stopped. The one idle main-pc session
was reattached with an exact-ID resume operation, without sending a prompt;
NAS had no managed sessions. Both hosts report online/reachable, the original
session identity is preserved and active/idle, and both managed process
executables report 0.153.4. Ordinary CLI/tmux sessions were not modified.
This targeted user-service activation required no sudo/system rebuild and
avoided unrelated pending Home Manager/NixOS changes.

## Sessions across multiple hosts — 2026-09-06

The UI now follows `sessions.search` continuation cursors across independent
control sources. A source can return a single row and still have a next page;
previously creating the first NAS session hid the main-pc list behind that
ignored cursor. The original Manifold record remained active/idle and readable
by exact ID throughout the incident.

Each refresh commits its pages together, retains the existing 500-row bound,
and labels a truncated or failed list. Only a complete, fresh projection may
remove an absent retained row. Selected exact-ID lookups now refresh on control
changes, reconnect/manual refresh, and a ten-second fallback poll, so an early
missing record cannot remain stuck until browser reload. Initial history
failure also retries when the same binding becomes active in the catalog or
starts a native turn; successful history is not reloaded on these events.

The fix is isolated from the paused Windows Copilot candidate and uses the
unchanged published 0.2.0 package graph. Typechecking, 341 tests, the production
build and shipped-container authentication/static-asset smoke pass. Browser
regressions cover external two-host creation, pagination, retained selection
and drafts, both conversations, early missing links, missed status events and
initial history recovery. No real model calls or production session mutations
are part of this verification.

The tested fix source `9637bdf` is deployed on NAS as
`sha256:7ab0b821d20536e5fbe89286557d5fa55b00c1007077b153bc6d05245ba9c135`
through `compose.cloudflare.yaml`; only its web/gateway container was recreated.
The private `.env.before-session-state-*` backup retains the previous image.
All served assets match the production build (HTML comparison removes the
per-response CSP nonce). Read-only browser checks show both existing sessions,
their native history and the two-row phone list. Main-pc and NAS control/runtime
PIDs are unchanged, and public unauthenticated access still redirects to
Cloudflare Access.

Final browser evidence is `receipts/browser/2026-09-06T04-54-38.097Z`
(62 checks across six viewports). The scrubbed, checksummed rollout receipt is
`receipts/session-state-deployment/2026-09-06T04-57-55.834Z`.
The separate fix review is [PR #2](https://github.com/arduano/leo-multiplex/pull/2).

### Four hosts and laptop sleep — 2026-09-06

Four independent sources now have explicit browser coverage with 100 sessions,
including colliding native thread/item IDs, host-specific models, drafts,
history, live events, pagination and six viewport sizes. The fixture repeats
simultaneous Windows/WSL outages three times with staggered recovery; always-on
hosts stay usable, unavailable session rows/drafts remain, and reconnects send
no agent commands. A separate integration test uses the published real role
services with mock adapters to verify host-specific launch/command/history
routing and repeated two-source outages without changing authority or identity.

The audit fixed two offline edges: a disappearing launch target previously
selected another host automatically, and a cached direct-link session outside
the visible list could retain enabled controls after losing its source. The
launch form now preserves the selected host and directory while unavailable;
direct links use the same source-availability protection as listed sessions.
Agent search also includes the displayed host name.

Typechecking, 342 tests, production/container builds and shipped-container smoke
pass. General browser evidence is `receipts/browser/2026-09-06T05-07-26.784Z`
(63 checks); four-host evidence is
`receipts/browser-multi-host/2026-09-06T05-09-39.462Z` (14 checks).
These are deterministic UI/role-service checks, not physical Windows/WSL
suspend/network qualification. The [NAS runbook](../deploy/nas/README.md#hosts-that-sleep-or-disconnect)
owns persistent identity, multi-host pairing and reconnect guidance.

Source `88abace` is deployed through the existing combined Compose project as
`sha256:6a1c71076de3a415dbfd2574f30e9894dec6fbf2e48185c87ca3a7cc85ba32a1`.
Only the web/gateway container was recreated; `.env.before-four-host-*` privately
retains its predecessor. Served assets match the tested build, both current
production conversations open, mobile lists both sessions, and both hosts'
control/runtime PIDs remain unchanged. Scrubbed, checksummed rollout evidence is
`receipts/four-host-deployment/2026-09-06T05-12-27.886Z`.
