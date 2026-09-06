#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: bash deploy/wsl/install.sh --revision <full-commit-sha>
       [--workspace /optional/restricted/root] [--secret-file /private/fleet-secret]
       [--install-dir /home/you/.local/state/leo-multiplex-wsl]
       [--name work-wsl] [--github-host github.com] [--check]

Run from a reviewed, clean checkout using Linux Git, Node 24 and its bundled npm.
Uses corporate Copilot, its own Linux state and separate ports.
Omit --workspace to allow any existing absolute agent/command working directory.
--check validates prerequisites only. Installation never starts or logs in a host.
USAGE
}

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then usage; exit 0; fi
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
installer_args=(--platform wsl)
check_only=0
while (($#)); do
  case "$1" in
    --revision|--workspace|--secret-file|--install-dir|--name|--github-host)
      if (($# < 2)) || [[ -z "$2" ]]; then printf 'Missing value for %s\n' "$1" >&2; exit 2; fi
      installer_args+=("$1" "$2"); shift 2 ;;
    --check) check_only=1; shift ;;
    *) printf 'Unknown installer option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

for executable in node npm git; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    printf 'Install the company-approved Linux %s inside WSL first.\n' "$executable" >&2; exit 1
  fi
done
cd -- "$repo_root"
node scripts/install-copilot-host.mjs preflight "${installer_args[@]}"
if ((check_only)); then
  printf '%s\n' 'Preflight passed. No installation, login or host startup performed.'; exit 0
fi
installer_npm=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync("package.json", "utf8")).packageManager)')
# Cache the install tool; only the inner, pinned npm runs reviewed native scripts.
printf 'Installing dependencies with cached %s. Global npm is unchanged.\n' "$installer_npm"
npm exec --yes --ignore-scripts --package="$installer_npm" -- npm ci --ignore-scripts=false --strict-allow-scripts --include=dev --include=optional
npm run build
node scripts/install-copilot-host.mjs configure "${installer_args[@]}"
