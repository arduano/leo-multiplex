# Accepted implementation plan

- Separate public arduano/leo-multiplex sister repository; framework reusable hooks only.
- Each host owns canonical control catalog plus runtime/native state. First host main-pc as arduano, Nix Home Manager services after publication. NAS only zero-authority gateway and personal web UI Docker ~/host/leo-multiplex.
- Codex only MVP: new managed sessions, supplied absolute existing workdir, all user-accessible roots, YOLO never/danger-full-access on launch/resume. Never touch/import/stop old Codex/tmux sessions.
- Managed CODEX_HOME separate from ~/.codex. At startup copy selected provider/model/effort config from ~/.codex/config.toml; preserve command-auth reference to existing token file. No credential reads in bootstrap, no separate login, no original config writes. Pin own Codex 0.152.0.
- Cloudflare Access sole browser login; app verifies signed JWT identity/issuer/aud/expiry plus allowed email; HTTP/WS origin checks, expiry closes sockets, no browser bearer UI or local token storage. Sign-in recovery preserves drafts using separate login tab. Cloudflare config is Leo's job, values pending.
- Personal UI retains reference conversation-first design/images/terminal. Simplified host/workdir/title/model/mode/effort creation. Remember recent workdirs. leo.local/workspace input cwd/model/effort/mode(default|plan); no raw collaborationMode.
- Keep observed unavailable-host rows only in browser memory, visibly stale; gateway/host reconnection must not imply catalog authority or fresh state. Disable stale mutations, preserve selected transcript/drafts.
- Retry uncertain operations with same ID/body, never create replacement implicitly. No import, general files, Copilot UI or new terminal CLI MVP.
- Validate focused tests, cross-role disposable mocks, six viewport screenshots/axe, Nix/Docker. No model calls until newly authorized. Framework release requires exact-SHA real four-container status; cannot bypass it. Current source protocol v5 version bumped 0.2.0 but not yet published.
- Publish framework, sister code/artifacts, integrate Nix, deploy new NAS only, pair by existing SSH, close enrollment. Preserve existing unrelated changes. GitHub source publication is authorized; no Cloudflare configuration.
