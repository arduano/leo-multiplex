# Work WSL Copilot host

This installer prepares a separate **Linux x64 WSL** work host using corporate
GitHub Copilot. It has its own catalog and native sign-in, independent of Windows
and the personal Codex hosts. WSL is a Linux deployment using the public framework
packages; the [native Windows release gate](../windows/README.md#release-status)
applies to the Windows installer. Corporate sign-in and physical laptop
sleep/network behavior still need device testing on both systems.

## Install

Use company-approved Linux Git, Node.js 24 x64 and npm 11.17.0 **inside WSL**.
The script checks existing tools and never runs sudo or installs global tools.
Clone onto the distro's Linux filesystem, outside the private install directory:

```bash
revision='<full 40-character commit from the installation handoff>'
git clone https://github.com/arduano/leo-multiplex.git "$HOME/leo-multiplex-src"
cd "$HOME/leo-multiplex-src"
git checkout --detach "$revision"

bash deploy/wsl/install.sh --revision "$revision" --workspace "$HOME/work" \
  --secret-file "$HOME/.private/leo-fleet-secret" --check
bash deploy/wsl/install.sh --revision "$revision" --workspace "$HOME/work" \
  --secret-file "$HOME/.private/leo-fleet-secret"
```

Create the workspace first. Repeat `--workspace` for more roots. Workspaces can
be approved mounted Windows directories; private installation/state must stay
on the Linux filesystem. Never share state or a native auth home with Windows,
copy another host's identities, or use Windows `node.exe`/Git/npm from WSL.
The roots fence Multiplex path operations; they are not an OS sandbox.

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

Keep the terminal open and follow
[pairing and enrollment closure](../../docs/Laptop-Hosts.md#join-the-existing-fleet).
Then Ctrl+C and `node "$leo_host" start` keeps enrollment closed for normal use.
Foreground startup creates no scheduled task, systemd service or automatic
prompt/resume operation. Closing WSL or sleeping the laptop disconnects this
host; its durable catalog remains local and the web UI retains observed rows.

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
profile/rc startup, the ordinary Linux account and a directory under an approved
root. Web exposes a separate **Experimental work commands** hatch in App settings.
Recovery survives a failed Copilot startup but still needs this WSL distribution,
foreground host and network online. See
[work commands](../../docs/Work-Host-Commands.md) for cancellation, limits and
recovery after an interrupted host process.
