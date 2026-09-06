# Work WSL Copilot host

This installer prepares a separate **Linux x64 WSL** work host using corporate
GitHub Copilot. It has its own catalog and native sign-in, independent of Windows
and the personal Codex hosts. WSL is a Linux deployment using the public framework
packages; the [native Windows release gate](../windows/README.md#release-status)
applies to the Windows installer. Corporate sign-in and physical laptop
sleep/network behavior still need device testing on both systems.

## Install

Use company-approved Linux Git, Node.js 24 x64 and its bundled npm **inside WSL**.
Setup uses the project's pinned npm from cache for dependency installation;
your global npm needs no version change. The lockfile and install-script policy
remain enforced.
The script checks existing tools and never runs sudo or installs global tools.
Clone onto the distro's Linux filesystem, outside the private install directory:

```bash
revision='<full 40-character commit from the installation handoff>'
git clone https://github.com/arduano/leo-multiplex.git "$HOME/leo-multiplex-src"
cd "$HOME/leo-multiplex-src"
git checkout --detach "$revision"

bash deploy/wsl/install.sh --revision "$revision" \
  --secret-file "$HOME/.private/leo-fleet-secret" --check
bash deploy/wsl/install.sh --revision "$revision" \
  --secret-file "$HOME/.private/leo-fleet-secret"
```

No workspace argument is needed. Select any existing absolute working directory
when creating an agent or running a recovery command, including mounted Windows
paths such as `/mnt/d/...`, using your account's normal access. Optional
`--workspace /root` values opt into a narrower starting-directory allowlist.
Private installation/state must stay on the Linux filesystem. Never share state
or native auth with Windows, copy host identities, or use Windows Node/Git/npm
inside WSL. Directory policy is not an OS sandbox.

Prepare the secret file through the shared
[fleet pairing instructions](../../docs/Laptop-Hosts.md#join-the-existing-fleet).
`--check` validates prerequisites without dependency installation, state writes,
login or startup. A normal run installs exact locked artifacts with their allowed
native scripts and optional packages, builds, then saves private configuration.
Keep this clean checkout at its installed revision; the launcher uses it.

| Setting | WSL |
| --- | --- |
| UI host name | `work-wsl` |
| Installation | `$XDG_STATE_HOME/leo-multiplex-wsl`, default `~/.local/state/leo-multiplex-wsl` |
| State and native auth | `<installation>/state` and `state/copilot` |
| Saved configuration | `<installation>/host-install.json` |
| Launcher | `<installation>/leo-host.mjs` |
| Control HTTP | `127.0.0.1:4319` |
| Control P2P | `0.0.0.0:49119` |

Initial overrides are `--install-dir`, `--name` and `--github-host company.ghe.com`.
The GitHub hostname selects the company's Enterprise Cloud data-residency host;
ordinary github.com is the default. Exact reruns retain the identity and may
omit the secret file after import. Stop this host before reinstalling dependencies.
Different saved settings, revision or fleet secret fail without overwriting state.

## Login and start

From any WSL shell:

```bash
leo_host="${XDG_STATE_HOME:-$HOME/.local/state}/leo-multiplex-wsl/leo-host.mjs"
node "$leo_host" login
node "$leo_host" doctor --json
node "$leo_host" start --enroll
```

Use your custom path if set. Verify the corporate GitHub account during login;
`login --device-code` can help when opening a Windows browser from WSL is awkward.
Each OS signs in separately. Leo does not copy OAuth credentials across them.
Proxy/CA variables are preserved, but inherited profile overrides are rejected
and personal Codex/provider tokens cannot replace the corporate account binding.

On headless WSL without a system keychain, native Copilot asks whether it may
store the login in its plaintext configuration. Answer that prompt in a terminal;
the managed Copilot directory is private to the Linux account. A noninteractive
device login can succeed at GitHub and still discard the token because it cannot
ask this question. In that case, repeat login interactively, then verify doctor.

Keep the terminal open and follow
[pairing and enrollment closure](../../docs/Laptop-Hosts.md#join-the-existing-fleet).
Then Ctrl+C and `node "$leo_host" start` keeps enrollment closed for normal use.
Foreground startup creates no scheduled task, systemd service or automatic
prompt/resume operation. Closing WSL or sleeping the laptop disconnects this
host; its durable catalog remains local and the web UI retains observed rows.

## Installed laptop background task

The current Ubuntu installation for Linux user `arduano` has a separate own-user
Windows task, **Leo Multiplex - work-wsl**. It starts at Windows sign-in with
Interactive logon and Limited privilege, no password/elevation, no battery stop
and no execution timeout. Its foreground `wsl.exe` waits on the Linux user unit
`leo-work-wsl.service`, keeping WSL active without an open terminal. Systemd
services alone do not keep a WSL instance alive. Signing out or sleeping the
laptop remains offline; locking it does not deliberately stop the task.

The private helpers belong to this particular installed distro/account, separate
from the clean pinned source checkout. Their reviewed copies are
[`work-laptop-service.ps1`](work-laptop-service.ps1) and
[`work-laptop-service.sh`](work-laptop-service.sh); these deliberately fix this
laptop's distro, Linux account and Node path. From Windows PowerShell:

```powershell
$wslService = Join-Path $env:LOCALAPPDATA 'leo-multiplex-windows/wsl-service/wsl-user-service.ps1'
& $wslService -Action Status
& $wslService -Action Stop
& $wslService -Action Start
```

`Stop` requests graceful Linux shutdown and waits for completion. Use Windows
command recovery for WSL service changes: stopping WSL disconnects its own command
endpoint. Never use Task Scheduler **End**, `wsl --terminate`, or `wsl --shutdown`
to manage this host; those can interrupt unrelated work. The separate initial
enrollment task has no sign-in trigger or retries; normal startup uses plain
`start`. Windows' existing host task is independent.

The helper pins native Node
`/home/arduano/.nvm/versions/node/v24.14.0/bin/node` and an explicit Linux PATH;
removing that Node installation requires a deliberate service update. Linux
service status exposes bounded lifecycle properties; native output is suppressed.
Use the installed launcher's `doctor --json` for authentication/model diagnostics.

The installed helpers are an operational setup for this laptop, not a new
portable service installer or automatic updater. The base installer remains
foreground-only. Keep the installed source revision and private state intact.

## Verify and recover

`doctor --json` checks private state, disposable SQLite, workspaces, pinned CLI,
corporate identity and model discovery without a prompt. Its bounded report is
the intended diagnostic; do not share native homes, environment dumps or pairing
contents. Network and gateway reachability are a separate manual check.

Use [the shared laptop acceptance check](../../docs/Laptop-Hosts.md#laptop-acceptance)
to exercise both hosts together. WSL provides Linux secure output-image paths;
uploaded-image vision still depends on the corporate model. Native Copilot
permission questions remain enabled; personal Codex YOLO settings do not apply.

If the host stays offline, check that WSL and the foreground process are running,
then check pairing and approved Iroh network reachability. Do not rebuild its
identity, duplicate the Windows state, or select another host as an implicit
fallback. Before upgrades, intentionally stop this host and privately back up
its full installation/state. Revision/configuration upgrades need a reviewed
migration; rerunning this setup script with new settings is deliberately rejected.

## Work command recovery

This installer enables a work-only recovery sidecar alongside the foreground
Copilot host, with its own durable endpoint/pin and UDP 49123. First pairing must
also confirm `leo-agents exec-hosts` reports `work-wsl` available before closing
enrollment. Deploy a gateway image containing this feature and merge the complete
private pairing document, including its `workHosts` descriptor.

The normal workflow is `leo-agents exec --host work-wsl --cwd /home/leo/work
--text 'git status --short' --request-id work-status-1`. Commands use Bash without
profile/rc startup, the ordinary Linux account and any existing absolute directory by default. Web exposes a separate **Experimental work commands** hatch in App settings.
Recovery survives a failed Copilot startup but still needs this WSL distribution,
foreground host and network online. See
[work commands](../../docs/Work-Host-Commands.md) for cancellation, limits and
recovery after an interrupted host process.
