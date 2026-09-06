# Corporate Windows Copilot host

This is the local installation and recovery path for a **Windows x64** Copilot
host. It uses corporate GitHub Copilot browser sign-in and a separate managed
Copilot home. It does not read the Codex configuration or use the Codex LB key.
The laptop owns its control catalog, runtime journals and native session state.

## Release status

**Do not install this as a working native Windows host yet.** The currently pinned
public framework graph (`0.2.0`) lacks Windows private-state support. Its update
is prepared in the framework repository, with a native Windows CI smoke. The
personal host fails closed when that update is missing. A qualified framework
patch release and this consumer's exact dependency update are required before
these instructions become the installation handoff. Linux tests and browser
fixtures alone do not establish Windows support.

The source candidate passed [native Windows CI](https://github.com/arduano/agent-multiplex/actions/runs/34011570520):
framework `96e2d3e165d7448dbf9cca41658a8467893fd5e7` with personal host
`b1b31996f1dff9eba024d14491258c081dd6db1d`. The run checks private state, SQLite,
uploaded-image retention, SDK startup, full control/runtime registration, graceful
stop and a restart with enrollment closed. It uses no corporate credentials,
creates no native conversation, and sends no prompts. Its checksummed receipts
are attached to that run. This source overlay is CI-only; installation still
requires published framework artifacts.

The first target is Windows x64, Node 24, a local NTFS state directory, and an
interactive standard-user login. Windows ARM64 has no pinned Iroh binary. The
Windows PowerShell/.NET ACL check must be allowed by corporate policy. It never
changes execution policy, disables TLS validation, or changes firewall rules.
The initial host runs in the foreground; scheduled tasks/services and automatic
updates are deliberately deferred until laptop UAT.

## Prepare locally

Use the company's approved installations of Git and Node.js 24 x64. In PowerShell,
clone this repository at the **release commit recorded in the eventual handoff**.
Do not use a moving branch for the installed host.

```powershell
git clone https://github.com/arduano/leo-multiplex.git
cd leo-multiplex
# git checkout <qualified-release-commit>
npm.cmd install --global --ignore-scripts npm@11.17.0
npm.cmd ci --strict-allow-scripts
npm.cmd run build
```

Keep optional dependencies enabled: they contain the pinned Windows Copilot and
transport binaries. A corporate npm mirror must retain those public packages and
the exact GitHub release tarballs in `package-lock.json`. Installation also needs
the allowed native dependency install scripts. If policy blocks them, diagnose
that requirement with IT instead of changing the policy from this runbook.

Set the same configuration in each shell that manages the host:

```powershell
$env:LEO_HOST_NAME = 'work-laptop'
$env:LEO_HARNESS = 'copilot'
$env:LEO_STATE_DIR = Join-Path $env:LOCALAPPDATA 'leo-multiplex-copilot'
$env:LEO_ALLOWED_ROOTS = '["C:\\Work"]'
```

Create the workspace through your normal company tooling first. More than one
drive/root is supported when explicitly configured. These roots fence Multiplex
path operations; they are **not** an OS sandbox. Copilot runs under your Windows
account and uses its native permission questions in the UI. Interactive, plan,
and autopilot retain their native meanings. The personal Codex YOLO settings do
not apply to this profile.

## Join the existing fleet and sign in

The NAS gateway currently has one transport enrollment secret for its control
sources. Before the laptop's first start, privately export **only** that existing
secret from the NAS gateway configuration into a small file. Transfer it through
a company-approved private channel. Never put its contents in a command line,
chat, source repository, URL, or diagnostics report.

```powershell
npm.cmd run host -- init --secret-file C:\Private\leo-enrollment-secret
npm.cmd run host -- login
npm.cmd run host -- doctor --json
```

`init` is idempotent for the same secret and refuses to replace an initialized
host's different secret. Remove the transfer file after successful import using
your normal local file management. The retained state copy stays private.

Login opens Copilot's native browser flow. Verify the **corporate GitHub account**
there. Organization SSO, seat assignment and CLI policy remain GitHub/company
decisions. Device-code login is available with `login --device-code`. Enterprise
Cloud data residency uses `$env:LEO_COPILOT_GITHUB_HOST = 'company.ghe.com'` in
every host-management shell; use the exact hostname supplied by the company.
That setting applies consistently to login, doctor and runtime startup and
overrides ambient `GH_HOST`. Ordinary github.com needs no setting.

The login command and SDK use the same `%LOCALAPPDATA%\leo-multiplex-copilot\copilot`
home. Copilot owns OAuth refresh and its OS credential-store behavior; Leo does
not copy or parse those credentials. Ambient GitHub tokens, `COPILOT_PROVIDER_*`,
Codex and OpenAI provider variables are removed from this child process so they
cannot override the sign-in. Standard proxy and CA variables remain available.
Successful login records only the account name and GitHub host in a private
account binding. Doctor and start compare the current identity against it and
refuse `gh` CLI fallback or a switched account; login again to deliberately
change accounts. Native auto-update is disabled for both login and runtime.

## Start and pair

```powershell
npm.cmd run host -- start --enroll
```

Leave this window open. In a second identically configured shell, use
`npm.cmd run host -- pairing` to locate the sensitive pairing document. Transfer
that file privately to the NAS operator. **Do not use `scripts/pair-nas.sh` for
this additional host**: that older first-host helper replaces the pairing file.

On an approved machine with this built checkout, merge the existing NAS pairing
document and the incoming laptop document into a new file:

```text
node scripts/merge-pairing.mjs existing-pairing.json laptop-pairing.json merged-pairing.json
```

The merge verifies the shared fleet secret and refuses duplicate source or
endpoint identities. Original files remain intact. Install the merged file
privately as the NAS Compose project's `config/gateway-pairing.json`, preserving
a private backup, then deliberately restart only the gateway container using
`compose.cloudflare.yaml`. This is an operator step during enrollment, not an
automatic action performed by this installer. Confirm that **all** prior hosts
and `work-laptop` are online in `https://agents.arduano.io`.

Press Ctrl+C in the laptop host window. Start again without `--enroll` to close
enrollment; existing pinned runtime/gateway identities reconnect:

```powershell
npm.cmd run host -- start
```

No SSH access into the laptop is needed. Tailscale availability has not been
confirmed. The Iroh transport has its own direct/relay connectivity requirements;
Copilot working through a corporate HTTP proxy does not prove this network path
works. Cloudflare Access protects the browser edge, not this host transport.
Keep enrollment testing on approved networks. If the laptop cannot reach the
NAS directly or approved Iroh relays, retain the doctor report and resolve the
network requirement before treating the host as usable.
Keep the normal P2P bind (`0.0.0.0:49117`) for initial Windows testing. A
loopback-only P2P bind failed the combined-host Windows test; the default bind
passed. The control HTTP listener remains loopback-only in both cases.

## Diagnose and recover

`doctor --json` emits a bounded report with fixed failure text, versions and model
counts. It probes a disposable SQLite store plus SDK status/authentication/model
discovery, without creating a session or sending a prompt. It does not include
tokens, account names, native history, environment dumps or provider endpoints.
An authentication pass is separate from the manual gateway-connectivity check.
The JSON report is the intended troubleshooting artifact; do not send the state
directory, native logs or pairing files.

- **Private-state failure:** first check the framework release. Then check that
  the directory is local and its ACL is private. Existing unsafe ACLs and
  junctions are rejected. Do not delete identities or weaken the ACL check.
- **Authentication/models failure:** rerun login under the same Windows account
  and state configuration. Check Copilot entitlement, SSO, proxy and approved CA
  settings. Do not substitute the personal Codex key.
- **Host offline:** keep the foreground process open and check enrollment,
  network policy and the new NAS source entry. Laptop sleep disconnects the
  runtime; the NAS cannot take over its catalog.
- **Stop/restart:** Ctrl+C closes only this combined control/runtime process.
  Existing managed sessions stay resumable. Restart does not send a prompt or
  automatically resume pending work. Other CLI or tmux sessions are untouched.
- **Upgrade:** intentionally stop the host, privately back up the complete state
  directory, install an exact qualified revision, and restart. Package rollback
  alone cannot undo database migrations. Keep the host name/state path stable.

## Laptop acceptance check

After the release gate clears, verify corporate login and model discovery, host
visibility, a new Copilot session in an existing Windows workspace, streaming,
permission/questions, model/mode switching, stop/resume after a host restart,
and reconnect after sleep. Real prompts are your UAT and consume Copilot usage.

Uploaded images have a Windows persistence smoke; model vision depends on the
selected corporate model. **Markdown/native output image paths still fail closed
on Windows** because secure opened-file path verification currently requires
Linux. Copilot's experimental stock TUI is disabled; use structured Chat.
Windows sudden-power-loss image durability and managed-laptop policy/auth/network
behavior are outside the automated startup smoke.
