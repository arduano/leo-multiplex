# main-pc Home Manager integration

`dotfiles.patch` is prepared against `/home/arduano/.dotfiles` for the `arduano`
user on `main-pc`. It adds the public Leo flake input and imports its Home Manager
module. It does not change `iso-gui.nix` or
`main-pc/system/hardware-configuration.nix`, which already have unrelated local
changes. The integration is applied locally and the operator has activated it. Current
rollout facts are in [Implementation status](../../docs/Implementation-Status.md).

## Publication boundary

The package lock references the public Agent Multiplex `v0.2.0` Release
artifacts with verified SHA-512 integrities. Pin the public Leo revision in the
dotfiles `flake.lock`; do not replace Release URLs with sibling paths or put
private npm configuration into Nix. Nix fetches all dependencies from public
sources. Development used local packs before release; deployment uses the
published tarball hashes.

## Local verification without activation

From this repository:

```sh
nix build .#host --no-link --print-out-paths -L
nix_node=$(nix eval --raw .#host.nodejs.outPath)
nix_host=$(nix eval --raw .#host.outPath)
"$nix_node/bin/node" nix/verify-host.mjs "$nix_host"
nix eval --impure --json --expr 'import ./nix/evaluate-home.nix {}'
git -C /home/arduano/.dotfiles apply --check "$PWD/deploy/main-pc/dotfiles.patch"
```

The verification script runs only `leo-codex --version`, native-module imports,
host-entrypoint imports, and an in-memory SQLite query. It never starts a host
service or a native session. The evaluation helper imports the existing
`main-pc` configuration and adds the module in memory. Build diagnostics and
verification output belong under the ignored `.cache/` directory.

## Review and build after publication

From the dotfiles checkout:

```sh
git status --short
git apply --check /home/arduano/programming/leo-multiplex/deploy/main-pc/dotfiles.patch
git apply /home/arduano/programming/leo-multiplex/deploy/main-pc/dotfiles.patch
nix flake update leo-multiplex
git diff -- flake.nix flake.lock main-pc/home/default.nix
nix build .#nixosConfigurations.main-pc.config.system.build.toplevel --no-link
```

The Leo input retains its own tested nixpkgs pin. The patch enables only the new
`leo-host.target`, `leo-control.service`, and `leo-runtime.service`. It uses
control HTTP on loopback port **4327** and a stable p2prpc UDP binding at
**49117**. Check that these two ports are free before activating this addition.
No firewall or Cloudflare changes are included.

System activation is a separate step. Use the usual reviewed `main-pc` NixOS
activation procedure only after the public-source build passes. Do not stop,
adopt, or migrate existing Codex, app-server, or tmux sessions. The services own
only `/home/arduano/.local/state/leo-multiplex`; its managed Codex home is the
`codex/` child of that directory. The original `~/.codex/config.toml` is read-only
input, and command-auth continues referencing the existing token file.

## First pairing only

Enrollment is closed in the permanent configuration. For the first install,
when this new state directory contains no managed sessions, open a temporary
control-service enrollment override:

```sh
systemctl --user edit --runtime leo-control.service
```

Enter:

```ini
[Service]
Environment=LEO_ENROLL_RUNTIMES=1
Environment=LEO_ENROLL_GATEWAYS=1
```

Then start/restart only the newly installed Leo services:

```sh
systemctl --user restart leo-control.service
systemctl --user start leo-host.target
systemctl --user is-active leo-control.service leo-runtime.service
```

The runtime waits for `control-source.json`, then enrolls its separate identity.
Once the new NAS Compose project is ready, run the repository's
`scripts/pair-nas.sh` to transfer `gateway-pairing.json` over the existing `nas`
SSH alias. Follow [the NAS runbook](../nas/README.md) for that project's startup
and Tailscale access configuration. Confirm the `main-pc` source is selected
and reachable. Do not print pairing files, tickets, provider configuration, or
shared secrets while verifying this.

Close enrollment by editing the **same runtime drop-in** and changing both
values to `0`, then restart only `leo-control.service`. The runtime and gateway
reconnect with their already enrolled identities; the Codex runtime process is
not restarted by this operation. The permanent Nix configuration also keeps
both flags false. Do not leave the temporary enrollment window open.

## Operation and retention

The control owns the canonical catalog; the runtime owns native Codex state,
images, and terminals. Stop/restart the new services only when changes require
it: runtime restarts release its managed processes, while stop keeps sessions
resumable. An explicit archive releases retained runtime images and provider
resources. Never infer archive from age or disconnection.

Back up the whole private Leo state directory while the new runtime/control
writers are stopped, including SQLite files, identity, images, and managed
Codex state. Keep provider credentials and the original auth token under their
existing private backup policy. Never clone a backup into a second live node
with the same identities.

The Nix host preserves the required glibc Iroh and node-pty modules. Its install
phase removes only Copilot's unused desktop-webview platform binary and koffi's
unused musl variant, and replaces the duplicate npm Codex vendor directory with
the same pinned, separately patched `0.152.0` payload. There is no blanket
`autoPatchelfIgnoreMissingDeps` exemption.
