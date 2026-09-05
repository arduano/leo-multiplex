# Implementation status — 2026-09-05

The personal host, gateway, UI, deployment packaging, and runbooks are implemented.
Production activation is pending the framework release and Cloudflare application
settings. Existing Codex and tmux sessions have not been adopted, modified, or
stopped. No new real-model calls were made for this implementation.

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
only `leo-codex --version` (`0.152.0`). Home Manager evaluation against main-pc and
the dotfiles patch dry-run pass. Neither changes nor activates the dotfiles.

All 16 framework tarballs were packed from clean source
`dbc8a713dcd276d4ef3d047c6c67a7561e7f1c7e` in
[framework PR #19](https://github.com/arduano/agent-multiplex/pull/19), now merged
as `0e043478538a30a0a42fd854f5f5c8a14309cbf0` with an identical source tree.
That source passes 598 tests and the framework typecheck, documentation,
checkpoint, and release-metadata gates. The lock records exact tarball SHA-512
integrities and future public `v0.2.0` Release URLs; transport remains the public
`0.2.1` artifact. Local npm/Docker/Nix verification seeds only matching artifact
bytes into disposable or content-addressed caches. It does **not** prove that
the unpublished URLs are downloadable. There are no sibling imports or local
file dependencies in the deployment manifests.

Passing browser manifests/screenshots and local implementation verification
inventories live in the ignored `receipts/` tree. Build and evaluation diagnostics
live in `.cache/`. Neither directory is published.

## Remaining rollout

1. Require the merged framework commit's main-branch CI, CodeQL, and deterministic
   Docker qualification to pass. PR CI/CodeQL passed and both image-pointer
   security findings were fixed before merge.
2. Run the framework's required native four-container qualification and 930-second
   soak against clean, exact `origin/main`, with a fresh explicit model allowance.
   Record the independently validated native status, then publish `v0.2.0` using
   the normal signed-tag workflow. See the framework
   [release procedure](https://github.com/arduano/agent-multiplex/blob/feat/protocol-v5-personal-embedding/docs/wiki/Releases.md#candidate-checklist).
3. Compare all public framework artifact integrities with this lock; update and
   revalidate if final published bytes differ. Require a fresh uncached CI build
   before deploying, then run **Publish NAS image** and retain its digest.
4. Follow [main-pc integration](../deploy/main-pc/README.md) to pin the public Leo
   revision in dotfiles, review/build, and activate only the new host services.
5. Supply public origin, Access team domain, AUD, and allowed email. Follow
   [NAS deployment](../deploy/nas/README.md), pair by SSH, then close enrollment.
   Cloudflare Tunnel/DNS/Access configuration belongs to Leo.

The source repository can be published before these rollout prerequisites are
met. Its initial CI cannot install framework `v0.2.0` until that release exists.
Do not substitute protocol-v4 artifacts, bypass the native release gate, or
activate against development source links to work around this dependency.
