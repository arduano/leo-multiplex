# Work laptop installation bootstrap

These code-only scripts prepare an exact source checkout and run the existing
[Windows](../windows/README.md) or [WSL](../wsl/README.md) installer. Use the full
tested personal-repository revision from the installation handoff. Download and
review the script before running it; no credential belongs in a download URL or
a gist. GitHub secret gists are unlisted, not access-controlled.

```powershell
.\install-windows.ps1 -Revision '<full 40-character tested revision>' `
  -Workspace 'C:\Work' -SecretFile 'C:\Private\leo-fleet-secret' -Check

# Remove -Check after preflight succeeds, then use the saved host launcher
# for corporate Copilot login, doctor and first enrollment.
```

```bash
bash install-wsl.sh --revision '<full 40-character tested revision>' \
  --workspace "$HOME/work" --secret-file "$HOME/.private/leo-fleet-secret" --check

# Remove --check after preflight succeeds. Login and enrollment are separate.
```

Use existing company-approved Git, Node.js 24 x64 and the repository's pinned
npm version. Neither bootstrap installs global tools, changes policy, logs in nor
starts a host. Windows must use the company's approved process for downloaded
PowerShell scripts; no execution-policy bypass or file unblocking is performed.
WSL uses Linux tools and a Linux filesystem source directory.

The persistent source defaults to
`%LOCALAPPDATA%\leo-multiplex-source-windows` or
`~/.local/share/leo-multiplex-source-wsl`. Override it with `-SourceDir` or
`--source-dir`. **Keep this directory at its installed revision**: the installed
launcher uses it. Host state remains in the separate installation directory
chosen by the underlying installer. `-Check`/`--check` downloads and prepares the
source before preflight; it does not install dependencies or create host state.

Rerunning accepts only the bootstrap's own clean checkout at the same exact
revision. Existing unrelated checkouts, local edits, changed origins/revisions,
symlinks and state/auth-directory overlaps are rejected without replacing them.
If the initial download is interrupted, its incomplete source is left in place
for inspection. Choose a new source directory to retry; do not remove host
state or overwrite a different installed revision.

Run the dependency-free wrapper checks with
`node --test tests/installation-bootstraps.mjs`. They use a disposable local Git
repository and installer stubs. Windows CI exercises both Windows PowerShell
and PowerShell; no wrapper check authenticates or calls a model.
