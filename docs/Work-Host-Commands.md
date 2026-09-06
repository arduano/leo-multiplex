# Commands on work laptop hosts

The normal entry point is `leo-agents`. App settings also provides an
**Experimental work commands** hatch for occasional recovery. Only the installed
Windows and WSL Copilot profiles publish these targets. Personal main-pc/NAS
hosts have no command service. This feature belongs entirely to Leo Multiplex;
Agent Multiplex's protocol, routers and packages are unchanged.

## CLI workflow

Use the same gateway URL, owner authentication and private operation directory
as the [agent CLI](Agent-CLI.md). No SSH connection or separate remote-shell
credential is needed.

```sh
leo-agents exec-hosts
leo-agents exec --host work-wsl --cwd /home/leo/work \
  --text 'git status --short' --request-id work-status-1
leo-agents exec --host work-windows --cwd 'C:\Work' \
  --text 'Get-ChildItem -Name' --request-id windows-list-1 --run-timeout 30
leo-agents exec-status work-status-1
leo-agents exec-cancel work-status-1
```

Choose a source ID or unique name from `exec-hosts`. `exec` saves the exact host
endpoint, operation UUID and request privately before sending it, then waits for
completion. Results include stdout, stderr, state and the process exit code.
A nonzero command exit produces a nonzero CLI result. `--run-timeout` is the
remote command limit in seconds; the CLI's ordinary `--timeout` only bounds its
local wait. Ctrl+C or a dropped connection does not cancel the remote command.
Keep the reported request ID and use `exec-status` to reconcile it.

A request ID always denotes the original immutable command and host endpoint.
Reusing it cannot change the command or retarget another machine. If status says
the host has no record, an explicit `exec-status REQUEST_ID --retry` sends the
same saved request and UUID. It never creates a replacement operation. When the
host reports `outcomeUnknown`, inspect the interrupted work; issuing a new ID
could repeat an external effect. Cancellation is explicit and scoped to the
exact operation.

## Behavior and limits

- Each work host admits one command at a time. A second command returns `BUSY`;
  it is not queued. Windows and WSL have independent executors.
- By default, `cwd` may resolve to any existing absolute directory accessible
  to the host account, including Windows `D:/...` and UNC shares. Optional
  installer workspace arguments narrow starting directories; they are not a
  filesystem sandbox.
- Windows uses system Windows PowerShell with profiles disabled; WSL uses Bash
  with profile and rc loading disabled. Commands are noninteractive, with stdin
  closed. They run as the ordinary host account, without elevation. Do not use
  this path for browser/device-code login or a persistent interactive shell.
- Commands are limited to 16 KiB, combined stdout/stderr to 128 KiB, and runtime
  to five minutes. Excess output is drained and marked truncated. Output is
  plain text in web. The host privately journals output, flushing progress every
  250 ms and at completion; a crash can lose the last unflushed output.
- Completion/cancellation reaps the owned Windows process job or WSL process
  group. WSL commands deliberately using `setsid`/daemonization can escape a
  process group; this trusted account-access tool is not process isolation.
- The host keeps at most 1,000 command records and refuses further new IDs when
  full. There is no automatic expiry that could make an old ID execute twice.
  `JOURNAL_FULL` requires planned local maintenance; do not delete the journal or
  reuse the endpoint identity with an empty journal. A future compaction path
  must preserve deduplication history.

The command environment withholds Leo, provider and GitHub credential variables
and shell startup overrides, while retaining ordinary toolchain, corporate proxy
and CA configuration. Commands still have the host account's file access. Treat
command inputs and requested output as private; this is not a restricted agent
sandbox or protection from code running under that account.

## Pairing and availability

The [laptop installation](Laptop-Hosts.md) creates a private `work-commands.json`
marker. Ordinary personal host startup does not enable this feature. The work
host starts its recovery service before checking Copilot authentication; a failed
Copilot doctor or runtime leaves command recovery available. After repairing
Copilot, restart that particular foreground host. Recovery cannot repair a host
whose OS, network, saved launcher, private state or transport cannot start.
The optional [Windows user task](../deploy/windows/README.md#run-in-the-background-under-your-windows-account)
keeps the whole host independent of an open terminal and provides graceful local
stop control. Install and start its waiting runner before closing the initial
foreground host, since that foreground process still owns remote recovery.

The service has its own durable endpoint identity and single pinned gateway,
under `<host-state>/work-commands`. Windows uses UDP 49121 and WSL UDP 49123.
It shares the existing fleet enrollment secret, but has a separate application
protocol and endpoint pin. Shared-secret membership alone never grants command
execution. It accepts the gateway pin only during explicit `start --enroll`.
The private `gateway-pairing.json` includes a `workHosts` descriptor beside the
ordinary control sources. `merge-pairing.mjs` retains all sources/descriptors and
rejects duplicate, colliding or orphan identities.

Install a gateway image containing this feature before merging these new
pairings. With each host running `start --enroll`, run `leo-agents exec-hosts` and
verify that host is available **before** stopping it and restarting without
`--enroll`. This enrolls both the normal control connection and recovery sidecar.
The NAS uses `LEO_GATEWAY_P2P_BIND` for both connections, avoiding automatic
advertisement of its many Docker bridge interfaces. With port `0`, each
connection receives its own ephemeral local port on the configured address.
Retain the gateway's private `work-commands/endpoint.key` and the host's endpoint,
`host-binding.json`, `gateway-peer.json`, and command journal together across
restarts. An offline target stays visible; another host is never selected for it.

Work-command locators currently have no automatic renewal. The ordinary control
connection has its own renewal path, so a visible agent host does not prove its
command route is current. A restart can change the implicitly bound IPv6 port
even though the configured IPv4 port stays fixed. If command access stops after
restart, privately transfer the running host's
`<host-state>/work-command-pairing.json`, verify its signed ticket and unchanged
source/platform/endpoint, and replace only that work host's locator in the
gateway pairing configuration before restarting the gateway. Back up the private
configuration first. Keep host identity, enrollment and journals intact; the
ordinary pairing merger rejects duplicate sources and is not a refresh tool.

All four HTTP routes (`hosts`, `submit`, `get`, `cancel`) under
`/api/work-commands/` use the existing authenticated gateway listener and require
`terminal-control`, including output reads. Mutations require the existing exact
Origin check. The gateway forwards bounded requests and keeps no durable command
output. The generic gateway projection and native agent APIs have no shell route.

## Web recovery hatch

Open App settings and expand **Experimental work commands**. Choose the work
host, directory and command explicitly. This is separate from normal agent
conversation and terminal controls. Pending request identity and input are kept
in private browser-origin storage for reload recovery; opening the hatch or
reconnecting never resubmits automatically. Use Check status, explicit retry, or
Cancel for the saved operation. Browser-profile access exposes saved inputs;
service-worker caches do not retain these API responses.

After a completed/rejected command, New command keeps its immutable request in
Saved command records. For uncertainty, Save for later asks for confirmation and
keeps that same recovery record while reopening the form. Opening a saved record
only checks host status. Delete explicitly removes its local input, leaving the
host journal intact and never cancelling or replaying a command. Resolve or save
the current operation before deleting saved records or clearing device data.
Command output is fetched from the host again when needed; it is not saved in
browser storage.

## Interrupted host process

On restart, previously running journal entries become `outcomeUnknown`. New
commands are blocked until the operator inspects the interrupted process tree
locally. Status and existing receipts remain available. After checking external
effects and terminating any surviving owned processes, stop this particular
foreground host and use its saved launcher:

```text
node <installed-leo-host.mjs> command-recovery <operation-uuid> --processes-inspected
node <installed-leo-host.mjs> start
```

The recovery command requires the journal writer to be stopped. It acknowledges
local inspection without changing the unknown result or replaying the command.
It accepts no PID and cannot kill an unrelated process. Each unacknowledged
interrupted operation requires inspection. Never delete state to clear this fence.

## Qualification boundary

Local tests exercise real disposable Bash commands, durable deduplication,
output/time limits, process-group cancellation, abrupt executor death, recovery,
real Iroh enrollment/reconnect, authenticated HTTP and client behavior without
native agents or model calls. Windows CI separately exercises the exact
PowerShell wrapper with harmless commands and process-job cleanup, without a
framework overlay. The full Windows journal/executor source-candidate smoke also
passes; installation still needs the published framework Windows update.
Corporate policy may prevent PowerShell
`Add-Type` or process-job assignment; such commands fail before user input runs.
Physical laptop suspend, corporate connectivity and installed Windows/WSL UAT
remain separate checks. No execution-policy, firewall or TLS setting is changed.

## Remote maintenance

A recovery command can download/build a reviewed release and register a separate
scheduled maintenance task. It cannot safely perform the stop-and-switch from
inside its own process tree: Windows commands own kill-on-close process jobs,
and stopping the host also interrupts the recovery command and its receipt.
An updater must finish admission first, run independently through Task Scheduler,
gracefully stop the host, preserve and back up all private state, then switch an
explicit source pin and verify restart. The current installers refuse in-place
revision changes; a supported automated update workflow is not implemented yet.
Use no automatic agent resume or model prompts as an update health check.
