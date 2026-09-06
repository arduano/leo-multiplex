# Laptop hosts: Windows and WSL

Both work environments use the corporate GitHub Copilot account. Personal Codex
stays on main-pc and home-nas. Each work host owns its catalog and state; the NAS
gateway observes all four. Install from the
[Windows](../deploy/windows/README.md) or [WSL](../deploy/wsl/README.md) runbook.
Start in foreground terminals for initial testing. The installers create no
scheduled task or background service and do not change installed personal hosts.
The [download bootstraps](../deploy/bootstrap/README.md) prepare a separate
checkout at the exact revision in the installation handoff, then run these
installers. They preserve existing source and state; keep their source checkout
for the saved launcher. Windows still requires the published framework update
described in its runbook.
Both installed work profiles also provide the bespoke
[command recovery service](Work-Host-Commands.md). The CLI is its normal entry
point; web exposes it only as an experimental App settings hatch.

## Join the existing fleet

1. Privately export **only the existing fleet enrollment secret** from the NAS
   gateway configuration into a small transfer file. This is transport enrollment,
   separate from corporate GitHub sign-in. Use the same fleet secret for both
   new hosts. Transfer it through an approved private channel; never paste its
   contents into commands, chat, source, URLs or diagnostics.
2. Pass the file path to the appropriate installer. The first install imports
   it into private state; a matching rerun is harmless, a different secret is
   rejected. Remove the transfer copy after successful import through normal
   local file management. Keep the retained private state copy.
3. Run the saved launcher with `login`, `doctor --json`, then `start --enroll`.
   Sign in separately on Windows and WSL and verify the corporate GitHub account.
   Leave the foreground host open during pairing. In another terminal use the
   same launcher with `pairing`: it prints the private file's location, not its
   contents. Transfer that file privately to the NAS operator.
4. On an approved Linux machine with this built checkout, merge each incoming
   pairing document into a **new** file:

   ```text
   node scripts/merge-pairing.mjs existing-pairing.json windows-pairing.json with-windows.json
   node scripts/merge-pairing.mjs with-windows.json wsl-pairing.json with-laptop.json
   ```

   Merge only available hosts if installing them separately. The merge checks
   the common fleet secret and refuses duplicate source/endpoint identities.
   Original files remain intact. **Do not use `scripts/pair-nas.sh`**: it is a
   first-host helper that replaces the source list.
5. Privately back up `~/host/leo-multiplex/config/gateway-pairing.json` on NAS,
   install the merged file at that path with owner-only permissions, then
   recreate only the web/gateway container in the existing project:

   ```bash
   cd ~/host/leo-multiplex
   docker compose -f compose.cloudflare.yaml up -d --no-deps --force-recreate web
   ```

   Check **all existing hosts plus each new host** in
   <https://agents.arduano.io>. The gateway image must include the work-command
   feature before importing its new `workHosts` descriptors. Run
   `leo-agents exec-hosts` and verify each installed work target is available
   before closing enrollment, so its separate recovery endpoint is pinned too.
6. Ctrl+C each laptop host and restart its launcher with plain `start` to close
   enrollment. Existing pinned runtime and gateway identities reconnect. Keep
   these state directories and names stable across future restarts.

No laptop SSH access is required. Tailscale on the corporate laptop is not a
prerequisite assumed by this setup. The Iroh host transport needs approved direct
or relay connectivity; successful GitHub proxy access does not test that path.
Cloudflare Access authenticates the browser edge, independently of host pairing.

## Laptop acceptance

After Windows' framework release gate clears, check both OS hosts together:

- Corporate login, model discovery, distinct host names and the expected work roots.
- Create a Copilot session on each host; check streaming, native permission and
  input questions, model/mode changes and image uploads. These real prompts are
  the operator's UAT and consume Copilot usage.
- Stop/restart the host and explicitly resume its test session with the same
  identity. Restart itself sends no prompt or automatic resume.
- Sleep and wake the laptop, including repeated Windows/WSL outages and recovery
  in either order. Main-pc and NAS must stay usable. Retained rows and drafts
  should remain visible, with unavailable hosts refusing new actions.
- Shut down WSL while Windows remains online, then restart WSL and its host.
  Verify separate availability, unchanged session IDs and no automatic retargeting.
- Run a harmless CLI command on each work target; check output, cancellation,
  reconnect/status recovery, and the experimental web hatch. Verify personal
  hosts are absent from `exec-hosts`. A failed Copilot doctor should leave work
  command recovery available while that foreground host remains running.

The deterministic four-host UI/routing suites exercise outages and reconnection;
they do not establish actual laptop suspend, corporate auth or network behavior.
Native Windows output-image paths remain unavailable; WSL uses the supported
Linux path checks. The experimental Copilot stock TUI remains disabled.

## Reruns and recovery

Keep the source checkout pinned and clean. A saved launcher refuses a changed
revision or conflicting `LEO_*` profile settings. Standard proxy and CA settings
can remain in the shell. Reinstall only after stopping this particular host and
leave it stopped until setup finishes. The installer checks existing writer locks
before rebuilding dependencies, but that check does not manage the process.
The setup scripts are not an upgrade manager.

If setup is interrupted, rerun the same revision/options. A leftover `.install-lock`
means configuration may still be running: inspect locally before removing only
that lock. Never delete state or identities to cure an offline host. Privately
back up complete state before any planned upgrade; reverting packages alone
cannot undo SQLite migrations. Corporate OAuth renewal belongs to Copilot;
rerun the saved `login` command when deliberate reauthentication is needed.
