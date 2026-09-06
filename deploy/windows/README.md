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

The source candidate passed [native Windows CI](https://github.com/arduano/agent-multiplex/actions/runs/34018354047):
framework `2184ec56f242b334c3fc3a7afaceb6f3756c01b4` with personal host
`c61f82a7537617f5ed55097a8ebcee5afd37897f`. The run checks private state, SQLite,
uploaded-image retention, SDK startup, full control/runtime registration, graceful
stop, a restart with enrollment closed, and eight real disposable work-command
executor checks including output, deduplication, cancellation and child cleanup.
It uses no corporate credentials,
creates no native conversation, and sends no prompts. Its checksummed receipts
are attached to that run. This source overlay is CI-only; installation still
requires published framework artifacts.

The first target is Windows x64, Node 24, a local NTFS state directory, and an
interactive standard-user login. Windows ARM64 has no pinned Iroh binary. The
Windows PowerShell/.NET ACL check must be allowed by corporate policy. It never
changes execution policy, disables TLS validation, or changes firewall rules.
The initial host runs in the foreground; scheduled tasks/services and automatic
updates are deliberately deferred until laptop UAT.

## Install from a pinned checkout

Use company-approved **Git, Node.js 24 x64 and npm 11.17.0**. The installer checks
these tools; it does not install or change global tools. Keep the repository on
a local drive, outside the installation/state directory, and leave this checkout
at its installed revision for the launcher to use.

```powershell
$Revision = '<full 40-character commit from the installation handoff>'
git clone https://github.com/arduano/leo-multiplex.git
cd leo-multiplex
git checkout --detach $Revision

# Check first; current public framework 0.2.0 deliberately stops here.
.\deploy\windows\install.ps1 -Revision $Revision `
  -SecretFile 'C:\Private\leo-fleet-secret' -Check

# After the release gate clears, install dependencies, build and save the host.
.\deploy\windows\install.ps1 -Revision $Revision `
  -SecretFile 'C:\Private\leo-fleet-secret'
```

By default, select any existing absolute working directory when creating an
agent or running a recovery command. `D:/...`, `C:/...`, other drives and UNC
shares are supported without an installer allowlist or drive enumeration.
Copilot uses your account's normal access with native permission questions.
If deliberately wanted later, `-Workspace @('C:\Work', 'D:\Projects')` opts into
a narrower starting-directory allowlist; it is not an OS sandbox.

The secret file must privately contain the **existing NAS fleet enrollment
secret**. Follow [fleet pairing](../../docs/Laptop-Hosts.md#join-the-existing-fleet)
for its preparation. Its path is an argument; its contents never are. `-Check`
reads and validates prerequisites without installing dependencies, creating state
or authenticating. The normal run executes locked `npm ci`, builds this checkout,
and imports the secret privately. Keep optional dependencies enabled; they carry
the pinned Windows Copilot and Iroh binaries. Approved mirrors must preserve the
locked public packages, release tarballs and permitted native install scripts.

Default installation:

| Setting | Windows |
| --- | --- |
| UI host name | `work-windows` |
| Installation | `%LOCALAPPDATA%\leo-multiplex-windows` |
| State and native auth | `<installation>\state` and `state\copilot` |
| Saved configuration | `<installation>\host-install.json` |
| Launcher | `<installation>\leo-host.mjs` |
| Control HTTP | `127.0.0.1:4317` |
| Control P2P | `0.0.0.0:49117` |

Use `-InstallDir 'C:\Private\leo-multiplex-windows'`, `-Name 'work-windows'` or
`-GitHubHost 'company.ghe.com'` to change those settings during initial setup.
The latter selects Enterprise Cloud data residency; use the exact company host.
Same-revision reruns require the same options and may omit `-SecretFile` after
import. Different saved settings or credentials fail without replacing state.
Stop this host before reinstalling its dependencies. This installer does not
perform in-place revision/configuration upgrades.

If corporate execution policy blocks the script, use the company's approved
script-signing/run process. The installer neither bypasses policy nor changes
firewall, TLS or privilege settings.

## Login and start

In any PowerShell terminal, use the saved launcher:

```powershell
$LeoHost = Join-Path $env:LOCALAPPDATA 'leo-multiplex-windows\leo-host.mjs'
node.exe $LeoHost login
node.exe $LeoHost doctor --json
node.exe $LeoHost start --enroll
```

Use your custom installation path if configured. No repeated `LEO_*` setup is
needed. Conflicting inherited Leo configuration is rejected; use a fresh shell
without another host's overrides. Standard corporate proxy and CA variables
remain available. `login --device-code` is also supported. Verify the corporate
GitHub account in the native sign-in flow; organization SSO, Copilot entitlement
and CLI policy still apply.

Leave the host terminal open, then follow the shared
[pairing and enrollment closure steps](../../docs/Laptop-Hosts.md#join-the-existing-fleet).
After pairing, stop with Ctrl+C and run:

```powershell
node.exe $LeoHost start
```

The saved launcher uses the corporate account binding, private home and pinned
Copilot binary consistently. Ambient GitHub/provider/Codex/OpenAI tokens cannot
replace this sign-in. Doctor/start reject `gh` CLI fallback and a switched
account; deliberately rerun login to change accounts. Native auto-update stays
disabled. Running the installer itself never starts a host or opens enrollment.

Keep the normal all-interface P2P bind for Windows testing: loopback-only P2P
failed the combined-host Windows smoke, while the default passed. The control
HTTP listener remains loopback-only. Copilot HTTP proxy connectivity does not
establish Iroh direct/relay reachability to the NAS; Cloudflare Access protects
the browser edge, not this transport.

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
  directory, follow a reviewed upgrade to an exact qualified revision, and restart. The setup
  script refuses to replace a different installed revision. Package rollback
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

## Work command recovery

This installer enables the Windows-only work command sidecar as part of the
foreground host. It uses UDP 49121 and a separate durable endpoint/pin beside
the ordinary control/runtime state. First pairing must also confirm
`leo-agents exec-hosts` reports `work-windows` available before enrollment closes.
The gateway image must contain this feature; merge the full private pairing file
so both its control source and `workHosts` descriptor are retained.

Use `leo-agents exec --host work-windows --cwd 'C:\Work' --text 'Get-ChildItem -Name'
--request-id work-list-1` from an authenticated CLI. Commands use installed Windows
PowerShell, normal account access and no profile or execution-policy override.
App settings offers a separate **Experimental work commands** hatch. Copilot
startup failure leaves recovery online; OS/network/private-state failure does
not. See [limits, pairing and interrupted-command recovery](../../docs/Work-Host-Commands.md).
The Windows framework release gate above still applies to the complete host.
