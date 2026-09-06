#!/usr/bin/env bash
# Source copies deliberately require --revision. An installation handoff may
# supply a tested full revision in its example; credentials never belong here.
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: bash install-wsl.sh --revision <full-commit-sha>
       --secret-file /home/you/.private/leo-fleet-secret
       [--source-dir /home/you/.local/share/leo-multiplex-source-wsl]
       [--install-dir /home/you/.local/state/leo-multiplex-wsl]
       [--workspace /optional/restricted/root] [--name work-wsl]
       [--github-host github.com] [--check]

Run inside WSL with company-approved Linux Git, Node 24 and npm. This downloads
the exact revision into a separate persistent source checkout, then runs its
reviewed WSL installer. Keep the source directory for the installed launcher.
Without --workspace, agents and recovery commands may use any existing absolute
directory. Explicit --workspace values opt into a starting-directory allowlist.
--check prepares source and checks prerequisites only; it does not install
dependencies, write host state, sign in or start the host. The installer reports
the pinned npm version. Login and enrollment are separate local steps.
USAGE
}

fail() { printf '%s\n' "$1" >&2; exit 1; }
if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then usage; exit 0; fi
revision=''
source_dir=''
install_dir=''
installer_args=()
declare -A seen=()
while (($#)); do
  case "$1" in
    --revision|--source-dir|--workspace|--secret-file|--install-dir|--name|--github-host)
      if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then fail "Missing value for $1"; fi
      if [[ "$1" != '--workspace' ]]; then
        [[ -z "${seen[$1]:-}" ]] || fail "Duplicate option: $1"
        seen[$1]=1
      fi
      case "$1" in
        --revision) revision="${2,,}" ;;
        --source-dir) source_dir="$2" ;;
        --install-dir) install_dir="$2"; installer_args+=("$1" "$2") ;;
        *) installer_args+=("$1" "$2") ;;
      esac
      shift 2 ;;
    --check)
      [[ -z "${seen[$1]:-}" ]] || fail "Duplicate option: $1"
      seen[$1]=1; installer_args+=(--check); shift ;;
    *) fail "Unknown option: $1 (use --help)" ;;
  esac
done
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || fail '--revision must be the full 40-character tested Git commit SHA.'
for executable in git node npm; do
  command -v "$executable" >/dev/null 2>&1 || fail "Install the company-approved Linux $executable inside WSL first."
done
source_dir="${source_dir:-$HOME/.local/share/leo-multiplex-source-wsl}"

# Validate the prospective source path without creating it. WSL Git/Node and
# source must be on the Linux filesystem; private host state is checked again
# by the exact installer after source preparation.
source_dir=$(node --input-type=module - "$source_dir" "$install_dir" <<'NODE'
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { homedir, release } from 'node:os';
const fail = text => { console.error(text); process.exit(1); };
if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24 ||
    !(process.env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(release())) || /\.exe$/i.test(process.execPath) || /^\/mnt\//i.test(process.execPath)) {
  fail('Use company-approved Linux x64 Node.js 24 or newer inside WSL.');
}
const input = process.argv[2];
if (!isAbsolute(input)) fail('--source-dir must be an absolute Linux filesystem path.');
const path = resolve(input);
for (let cursor = path; ; cursor = dirname(cursor)) {
  try { if (lstatSync(cursor).isSymbolicLink()) fail('The source path and its parents must not be symlinks.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (cursor === dirname(cursor)) break;
}
const within = (child, parent) => { const value = relative(parent, child); return value === '' || (value !== '..' && !value.startsWith('../') && !isAbsolute(value)); };
const canonical = value => { try { return realpathSync(value); } catch (error) { if (error.code !== 'ENOENT') throw error; return join(canonical(dirname(value)), value.slice(dirname(value).length)); } };
const source = canonical(path);
if (source === parse(source).root || source === realpathSync(homedir()) || /^\/mnt(?:\/|$)/i.test(source)) fail('Use a separate source directory on the WSL Linux filesystem.');
const stateBase = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
const install = process.argv[3] || join(stateBase, 'leo-multiplex-wsl');
if (!isAbsolute(install)) fail('--install-dir must be an absolute Linux filesystem path.');
const forbidden = [install, join(homedir(), '.codex'), join(homedir(), '.copilot'),
  ...['leo-multiplex', 'leo-multiplex-copilot', 'leo-multiplex-windows'].map(name => join(stateBase, name))];
if (forbidden.some(value => { const target = canonical(resolve(value)); return within(source, target) || within(target, source); })) {
  fail('Keep the source checkout separate from host installation/state and existing native auth homes.');
}
for (const line of readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
  const [info, type] = line.split(' - ');
  const mountpoint = info?.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  if (mountpoint && /^(9p|drvfs|cifs|smb3|nfs4?|fuse\.)\b/.test(type ?? '') && within(source, mountpoint)) fail('The source checkout must use the WSL Linux filesystem, not a shared mount.');
}
console.log(source);
NODE
)

repository='https://github.com/arduano/leo-multiplex.git'
marker="$source_dir/.git/leo-bootstrap-revision"
run_git() {
  git -c core.hooksPath="$source_dir/.git/leo-empty-hooks" "$@" 2>/dev/null || fail 'Git could not prepare or verify the pinned source. No host was started; the source was left in place.'
}
if [[ -e "$source_dir" ]]; then
  [[ -d "$source_dir/.git" && ! -L "$source_dir/.git" && -f "$marker" && ! -L "$marker" ]] || fail 'The source directory already exists and is not a bootstrap-owned checkout. Choose another --source-dir; existing files were preserved.'
  [[ "$(<"$marker")" == "$revision" ]] || fail 'The source directory belongs to another revision. Choose another --source-dir; the existing checkout was preserved.'
else
  mkdir -p -- "$(dirname -- "$source_dir")"
  mkdir -- "$source_dir"
  run_git -c init.templateDir= init --quiet "$source_dir"
  run_git -C "$source_dir" remote add origin "$repository"
  run_git -C "$source_dir" fetch --quiet --depth=1 --no-tags origin "$revision"
  [[ "$(run_git -C "$source_dir" rev-parse 'FETCH_HEAD^{commit}')" == "$revision" ]] || fail 'Git returned a different commit; installation stopped.'
  run_git -C "$source_dir" checkout --quiet --detach "$revision"
  printf '%s\n' "$revision" > "$marker"
fi
[[ "$(run_git -C "$source_dir" rev-parse --show-toplevel)" == "$source_dir" ]] || fail 'The source directory is not the expected standalone checkout.'
[[ "$(run_git -C "$source_dir" config --get remote.origin.url)" == "$repository" ]] || fail 'The source repository changed; existing files were preserved.'
[[ "$(run_git -C "$source_dir" rev-parse HEAD)" == "$revision" ]] || fail 'The source revision changed; existing files were preserved.'
source_status=$(run_git -C "$source_dir" status --porcelain --untracked-files=all)
[[ -z "$source_status" ]] || fail 'The source checkout has local changes; existing files were preserved.'
printf 'Using pinned source: %s\n' "$source_dir"
exec bash "$source_dir/deploy/wsl/install.sh" --revision "$revision" "${installer_args[@]}"
