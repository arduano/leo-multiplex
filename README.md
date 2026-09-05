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

The coordinated Agent Multiplex 0.2.0 release is still pending. Until it is
published, a fresh `npm ci` or public Nix/Docker build cannot fetch those pinned
artifacts. Local verification used matching packed tarballs in disposable
caches. See [implementation status](docs/Implementation-Status.md) for evidence
and remaining deployment steps. Do not mix protocol-v4 0.1.0 packages with this
application.

The UI derives from Agent Multiplex's MIT-licensed React demo. It retains native
Codex history, streaming, images, questions, settings, lifecycle operations, and
managed terminal attachment. SVG interpretation remains client-side. Third-party
browser notices are included in `apps/web/THIRD_PARTY_LICENSES.txt`.

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
