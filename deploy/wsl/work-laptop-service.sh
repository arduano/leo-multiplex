#!/usr/bin/env bash
# Private helper for the existing Ubuntu/arduano installation. No sudo, login,
# dependency installation or unrelated service changes are performed here.
set -euo pipefail
umask 077

leo_user='arduano'
leo_install='/home/arduano/.local/state/leo-multiplex-wsl'
leo_node='/home/arduano/.nvm/versions/node/v24.14.0/bin/node'
leo_unit='leo-work-wsl.service'
leo_command="${1:-status}"
if (($# > 1)); then printf '%s\n' 'Use check, run, run-enrollment, stop or status.' >&2; exit 2; fi
case "$leo_command" in check|run|run-enrollment|stop|status) ;; *) printf '%s\n' 'Unknown service command.' >&2; exit 2;; esac

export PATH="${leo_node%/*}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [[ "$(id -un)" != "$leo_user" ]] || [[ "$(id -u)" == 0 ]]; then
  printf '%s\n' 'Run as the installed Linux account, not root.' >&2; exit 1
fi
if [[ "$(</proc/sys/kernel/osrelease)" != *[Mm]icrosoft* ]]; then
  printf '%s\n' 'This private helper requires the installed WSL distribution.' >&2; exit 1
fi
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
if [[ ! -d "$XDG_RUNTIME_DIR" || ! -S "$XDG_RUNTIME_DIR/bus" ]] ||
   [[ "$(stat -c %u "$XDG_RUNTIME_DIR")" != "$(id -u)" ]]; then
  printf '%s\n' 'The existing systemd user manager is unavailable; no system settings were changed.' >&2; exit 1
fi
systemctl --user show-environment >/dev/null

case "$leo_command" in
  check)
    [[ -x "$leo_node" && -f "$leo_install/leo-host.mjs" && ! -L "$leo_install/leo-host.mjs" ]]
    # The installed launcher validates the pinned checkout and private config.
    # Help never probes models, starts a host, or modifies auth.
    "$leo_node" "$leo_install/leo-host.mjs" help >/dev/null
    printf '%s\n' 'Existing WSL launcher and user manager are ready.'
    ;;
  status)
    systemctl --user show "$leo_unit" --no-pager \
      --property=Id,LoadState,ActiveState,SubState,Result,MainPID,ExecMainStatus,ActiveEnterTimestamp
    ;;
  stop)
    # Issue through the independent Windows command endpoint: stopping WSL
    # necessarily disconnects WSL's own command endpoint. Never kill its PID.
    systemctl --user stop "$leo_unit"
    printf '%s\n' 'The WSL host stopped gracefully.'
    ;;
  run|run-enrollment)
    [[ -x "$leo_node" && -f "$leo_install/leo-host.mjs" && ! -L "$leo_install/leo-host.mjs" ]]
    leo_args=(start)
    [[ "$leo_command" != run-enrollment ]] || leo_args+=(--enroll)
    leo_env=(--setenv=PATH)
    # Existing manager environment is retained. Explicit inherited proxy/CA
    # settings are forwarded by name, without values in process arguments.
    for leo_key in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR GIT_SSL_CAINFO; do
      [[ ! -v "$leo_key" ]] || leo_env+=("--setenv=$leo_key")
    done
    # --wait keeps the Windows wsl.exe invocation alive. The Linux user manager
    # owns the host process; exact unit identity prevents concurrent hosts.
    # SIGTERM reaches Node first; graceful stop is never replaced by a timeout kill.
    exec systemd-run --user --wait --collect --quiet --unit="$leo_unit" \
      --service-type=exec --property=KillMode=mixed --property=TimeoutStopSec=infinity \
      --property=StandardInput=null --property=StandardOutput=null --property=StandardError=null \
      --working-directory="$leo_install" "${leo_env[@]}" \
      "$leo_node" "$leo_install/leo-host.mjs" "${leo_args[@]}"
    ;;
esac
