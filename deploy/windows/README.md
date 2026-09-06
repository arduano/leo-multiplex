# Corporate Windows Copilot host

This is the local installation and recovery path for a **Windows x64** Copilot
host. It uses corporate GitHub Copilot browser sign-in and a separate managed
Copilot home. It does not read the Codex configuration or use the Codex LB key.
The laptop owns its control catalog, runtime journals and native session state.

## Release status

The current source pins published framework **0.2.2**, adding native Copilot
permission controls to the Windows private-state and path-policy support. The
[downloadable installer handoff](https://gist.github.com/arduano/13b94161cb7ebfb054a2d4629b764aa5)
records the exact installation revision.

[Published Windows qualification](https://github.com/arduano/leo-multiplex/actions/runs/34024286247) runs checks for all 16 public
artifact integrities, executes the actual installer on disposable `D:` state,
verifies saved private configuration and launcher help, removes the transfer
secret, and passes rerun preflight using the saved copy. The same run verifies
host registration, graceful stop/restart with enrollment closed, directory
selection across C:/D: and nine real harmless work-command executor checks.
There is no source overlay, corporate login or model call in this qualification.
Corporate OAuth/network/share/suspend behavior remains laptop UAT.

The first target is Windows x64, Node 24, a local NTFS state directory, and an
interactive standard-user login. Windows ARM64 has no pinned Iroh binary. The
Windows PowerShell/.NET ACL check must be allowed by corporate policy. It never
changes execution policy, disables TLS validation, or changes firewall rules.
Initial pairing runs in the foreground. The optional current-user background
task below starts at sign-in; updates remain an explicit maintenance operation.

## Install from a pinned checkout

Use company-approved **Git, Node.js 24 x64 and its bundled npm**. The installer checks
runtime prerequisites without requiring a particular installed npm version.
For dependency installation, standard `npm exec` runs the project's pinned npm
from cache, preserving the lockfile and install-script policy. Global npm stays
unchanged. Keep the repository on a local drive, outside the installation/state
directory, and leave this checkout at its installed revision for the launcher
to use.

```powershell
$Revision = '<full 40-character commit from the installation handoff>'
git clone https://github.com/arduano/leo-multiplex.git
cd leo-multiplex
git checkout --detach $Revision

# Check the exact public dependency graph and local prerequisites first.
.\deploy\windows\install.ps1 -Revision $Revision `
  -SecretFile 'C:\Private\leo-fleet-secret' -Check

# Install dependencies, build and save the host.
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

## Run in the background under your Windows account

After pairing, use the reviewed `deploy/windows/service.ps1` and its matching
`scripts/windows-user-service.mjs` from the service handoff. This add-on uses the
existing installed launcher and preserves its exact source pin, identity and
Copilot sign-in; there is no host reinstallation.

```powershell
.\deploy\windows\service.ps1 -Action Install -StartNow
```

The task is named **Leo Multiplex - work-windows** (using your configured host
name). It runs at normal user privilege, without a password or administrator
rights, starts when that account signs in, and continues while locked. It has
no run-time limit or battery-stop rule. Windows sleep/sign-out takes the host
offline. Task Scheduler can restart a failed runner up to three times, one
minute apart; it does not automatically resume an agent or send a prompt.

Install and start the task **before closing the initial foreground host**. The
background runner waits for that host's writer locks. Once it reports waiting,
press Ctrl+C in the old terminal once. It then takes over with enrollment closed.
The original foreground host owns command recovery until this handoff, so
closing it before the task is installed would remove remote installation access.
After handoff, ordinary terminal closure has no effect on the background task.

```powershell
$LeoRunner = Join-Path $env:LOCALAPPDATA 'leo-multiplex-windows\service\runner.mjs'
node.exe $LeoRunner status
node.exe $LeoRunner stop
# After graceful shutdown, start it again:
Start-ScheduledTask -TaskName 'Leo Multiplex - work-windows'
```

Use the runner's `stop` command for planned shutdown. Task Scheduler's **End**
action is forceful and is not the routine stop path. Local status/control files
are private and contain no Copilot output or credentials. The task uses the
account's sign-in environment; shell-only proxy/CA settings must be configured
through the normal company-approved user environment when needed.

### Updates and recovery commands

Recovery commands can stage a reviewed update and schedule its application;
there is no automatic push updater yet. Do not `git pull` or run `npm ci` in the
live pinned checkout: the installed launcher deliberately refuses changed source.
A supported update must build a separate exact checkout, finish the recovery
command, then let an independent scheduled task stop the host gracefully,
back up the complete private state, switch the saved source revision, restart
with enrollment closed, and check readiness. Keep account, state and identities.
Code rollback alone cannot undo database migrations.

The updater must be started by Task Scheduler, outside the recovery command's
process tree. Command descendants are killed when that command exits, so an
ordinary detached `Start-Process` is not a durable update handoff. Updating or
stopping the whole host briefly disconnects recovery. A stopped OS, signed-out
account or unavailable network still needs local recovery before remote commands
can work again.

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
The complete host uses the qualified published framework graph recorded above.
