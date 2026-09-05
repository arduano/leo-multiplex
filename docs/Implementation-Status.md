# Implementation status — 2026-09-05

The personal host, gateway, UI, deployment packaging, and runbooks are implemented.
Production activation is pending the operator's sudo rebuild and Tailscale
MagicDNS/HTTPS settings. Cloudflare is postponed until the Tailscale trial works.
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

The implementation passed application typechecking, 32 tests in nine files, and
a production build. The cross-role mock test covers launch retry, metadata
authority, stop/resume, unavailable-source rejection, catalog reopening, and
archive release order. Authentication tests exercise signed HTTP/WS access and
expiry. Browser qualification covers six viewport screenshots and 14 checks,
with no serious or critical axe findings. These checks do not prove real-model
behavior through the new deployment.

The Docker image passes a network-disabled smoke run using disposable signing
keys: built HTML/assets load, the gateway reports zero authority, and missing
authentication/configuration or a wrong origin fail closed. Production has no
fixture-key configuration. Compose and pinned GitHub workflows validate.

The Nix package builds with no unresolved ELF dependencies. Verification imports
Iroh, node-pty, transport, and host entrypoints, checks in-memory SQLite, and runs
only `leo-codex --version` (`0.152.0`). The public flake is pinned in main-pc's
dotfiles, and its full system build passed without activation. Existing unrelated
dotfiles changes and dependency pins were preserved.

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

## Remaining rollout

1. Complete the application checks and Docker image using the final public lock.
2. Update the dotfiles Leo pin and build, then let the operator run the sudo
   rebuild. Pair only the new host/runtime/gateway and close enrollment.
3. Enable Tailscale MagicDNS and HTTPS certificates in the tailnet admin DNS
   settings. Use the dedicated Serve port 8443, preserving the existing port 443
   route. Follow [NAS deployment](../deploy/nas/README.md).
4. Verify the real NAS browser path, host availability, and web session workflow.
   Existing CLI/tmux sessions remain outside this application's ownership.

Cloudflare Tunnel/DNS/Access setup remains the operator's later task. Tailscale
access must not be replaced with unauthenticated LAN or public exposure.
