# Run from a reviewed checkout pinned to the full revision supplied below.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Revision,
    [string[]]$Workspace = @(),
    [string]$SecretFile,
    [string]$InstallDir,
    [string]$Name = 'work-windows',
    [string]$GitHubHost = 'github.com',
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$helper = Join-Path $repoRoot 'scripts/install-copilot-host.mjs'

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Installer step failed (exit $LASTEXITCODE). No host was started." }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'Run this installer in Windows PowerShell. Use deploy/wsl/install.sh inside WSL.' }
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $null = Get-Command git.exe -CommandType Application -ErrorAction Stop
    $options = @('--platform', 'windows', '--revision', $Revision.ToLowerInvariant(), '--name', $Name, '--github-host', $GitHubHost)
    foreach ($root in $Workspace) { $options += @('--workspace', $root) }
    if ($SecretFile) { $options += @('--secret-file', $SecretFile) }
    if ($InstallDir) { $options += @('--install-dir', $InstallDir) }
    Push-Location $repoRoot
    try {
        # The shared helper checks platform, source pin, public dependency pins,
        # separate state, workspaces and release readiness before installation.
        Invoke-Checked $node (@($helper, 'preflight') + $options)
        $expectedNpm = ((Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).packageManager -replace '^npm@', '')
        $actualNpm = (& $npm --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $actualNpm -ne $expectedNpm) {
            throw "npm $expectedNpm is required. Install the approved version before rerunning; this script does not change global tools."
        }
        if ($Check) { Write-Output 'Preflight passed. No installation, login or host startup performed.'; return }
        Invoke-Checked $npm @('ci', '--strict-allow-scripts', '--include=dev', '--include=optional')
        Invoke-Checked $npm @('run', 'build')
        Invoke-Checked $node (@($helper, 'configure') + $options)
    } finally { Pop-Location }
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
