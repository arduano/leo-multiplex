# Leo Multiplex

Leo's personal Codex workspace, built on Agent Multiplex protocol v5.

Each host owns its canonical session catalog and Codex runtime. The web application
on home-nas connects to those hosts through a zero-authority gateway. The first
host is main-pc, running as `arduano` with full account access in the selected
existing working directory.

**Existing Codex and tmux sessions are outside this application's ownership.**
Setup, tests, deployment, and shutdown never adopt or terminate them. All managed
sessions use a separate Codex home and app-server process.

## Development

Use Node 24.19.0 and npm 11.17.0. Install exact locked dependencies, then:

```sh
npm ci --strict-allow-scripts
npm run typecheck
npm test
npm run build
```

Dependencies pin the public Agent Multiplex 0.2.0 release with exact tarball
integrities. See [implementation status](docs/Implementation-Status.md) for
verification and deployment progress. Do not mix protocol-v4 0.1.0 packages with
this application.

The UI derives from Agent Multiplex's MIT-licensed React demo. It retains native
Codex history, streaming, images, questions, settings, lifecycle operations, and
managed terminal attachment. SVG interpretation remains client-side. Third-party
browser notices are included in `apps/web/THIRD_PARTY_LICENSES.txt`.

The personal interface keeps the conversation prominent, with hosts in the left
rail and details collapsed initially. Text drafts, image attachments, and uncertain
command IDs survive switching agents in the same tab. They remain in memory and
do not survive a page reload.

Native failures have a persistent warning and dedicated transcript notice, with
separate guidance for capacity, usage, rate, budget, context, and sign-in errors.
The UI preserves Codex's automatic-retry signal and never retries a failed prompt
on its own. For an earlier error omitted by the published history API, it checks
native status and directs you to Terminal before continuing.

Type `/` in the composer for commands such as `/plan`, `/model`, and `/effort`.
The applied model beside the prompt opens model and native reasoning choices
directly. See [workspace commands](docs/Workspace-Commands.md) for keyboard controls
and next-turn settings semantics.

Long conversations render a measured window of up to 200 messages. Native updates
touch individual items and are batched before painting; large message bodies use
bounded parts. Opening a thread automatically reads toward its latest messages
in bounded pages and follows the bottom. Loading can be stopped; scrolling up
keeps your place while it continues. **Load to latest** continues a stopped load.
Live messages remain available while history loads. See the
[browser qualification](tests/browser/README.md) for the 50,000-turn fixture and
the measured performance limits.

## Agent CLI

`leo-agents` exposes the managed workspace to terminal tools and agent runners
through the existing gateway. It returns JSON (NDJSON for event streams), keeps
mutation IDs in a private ledger, and distinguishes command acknowledgment from
native turn completion. It supports session creation, messages, native commands,
questions, history, and image transfer without restarting host services.

After building, run `npm run cli -- help`. See the
[Agent CLI runbook](docs/Agent-CLI.md) for installation, request reconciliation,
image examples, and OpenClaw integration.

## Host

The Home Manager module exports `services.leo-host`. The Nix package pins its own
Codex binary; it does not replace the ordinary `codex` command. The default state
root is `~/.local/state/leo-multiplex`:

| Path | Owner / purpose |
| --- | --- |
| `control/catalog.sqlite` | Canonical host catalog |
| `control/identity` | Durable control endpoint |
| `runtime/` | Bindings, journals, runtime identity and retained images |
| `codex/` | Managed native Codex state and generated configuration |
| `shared-secret` | Private transport enrollment credential |
| `control-source.json` | Runtime bootstrap locator |
| `gateway-pairing.json` | Sensitive gateway pairing document |

The runtime reads `~/.codex/config.toml` at startup and privately copies the
selected model/provider configuration. The existing command-auth helper continues
to read the same credential file. There is no extra Codex login and the original
configuration is never written. Credential refresh is native; provider config
changes take effect at the next intentional managed-runtime restart.

The `leo.local/workspace` profile accepts `cwd`, optional `model`, `effort`, and
`mode` (`default` or `plan`). Creation and resume always use `never` approval and
`danger-full-access`. The host checks that the absolute workdir exists and is a
directory. Archive releases managed resources but never deletes that workdir.

`leo-control.service` and `leo-runtime.service` belong to `leo-host.target`.
See [the main-pc runbook](deploy/main-pc/README.md) for the prepared dotfiles patch,
module evaluation, installation, and initial pairing.
Restarting the runtime interrupts active execution and discards managed PTYs;
stored conversations remain resumable. Closing a browser or managed TUI leaves
the service running. Existing external sessions are not involved.

## NAS and authentication

See [the NAS runbook](deploy/nas/README.md). Deploy only this application's Compose
project under `~/host/leo-multiplex`. It does not host canonical session state.

The server supports [Tailscale Serve authentication](docs/Tailscale-Authentication.md)
and Cloudflare Access as separate modes. Both enforce the owner email and browser
origin for HTTP and WebSocket connections. Tailscale mode requires a loopback
socket peer and Serve's user identity, with host networking and an enforced
loopback listener. Cloudflare mode verifies signed assertions against the configured
team, audience, and expiry. Neither mode asks for an app password or browser
bearer token. Cloudflare setup can be added later by Leo.

## Recovery and upgrades

Back up host control, runtime, managed Codex state, and identities together.
Stop only `leo-host.target` before copying raw SQLite/WAL files, or use supported
SQLite backup APIs. Treat backups as private credential-bearing data. Back up
NAS gateway identity/state and pairing configuration separately; they cannot
replace the host catalog.

Pin upgrades to immutable releases. Test a disposable state copy first. Preserve
a coordinated pre-upgrade backup because a package rollback cannot undo database
migrations. Do not automatically restart active managed agents on source/config
changes. Do not recover by deleting identity files or generating duplicate realms.

When a host disconnects, previously observed rows are stale. A new gateway cannot
reconstruct that catalog until the host reconnects. No offline gateway copy becomes
authoritative.
