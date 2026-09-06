<#
.SYNOPSIS
Downloads one exact reviewed revision and runs its corporate Copilot installer.
.DESCRIPTION
Uses existing company-approved Git, Node 24 and npm as a standard user. The
persistent source checkout is separate from host state. Check still prepares
source, then performs installer preflight without installing dependencies,
writing host state, signing in or starting a host. No policy or global tools are
changed. Use the company's approved script process if downloaded scripts are
blocked; this bootstrap does not remove that protection.
.EXAMPLE
.\install-windows.ps1 -Revision '<full-commit-sha>' -SecretFile 'C:\Private\leo-fleet-secret' -Check
.EXAMPLE
.\install-windows.ps1 -Revision '<full-commit-sha>' -SecretFile 'C:\Private\leo-fleet-secret'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Revision,
    [string[]]$Workspace = @(),
    [string]$SecretFile,
    [string]$SourceDir,
    [string]$InstallDir,
    [string]$Name = 'work-windows',
    [string]$GitHubHost = 'github.com',
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    if ($env:OS -ne 'Windows_NT') { throw 'Run this bootstrap in Windows PowerShell. Use install-wsl.sh inside WSL.' }
    $git = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $null = Get-Command node.exe -CommandType Application -ErrorAction Stop
    $null = Get-Command npm.cmd -CommandType Application -ErrorAction Stop
    $Revision = $Revision.ToLowerInvariant()
    if (-not $SourceDir) {
        if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; supply -SourceDir on a local drive.' }
        $SourceDir = Join-Path $env:LOCALAPPDATA 'leo-multiplex-source-windows'
    }
    if ($SourceDir -notmatch '^[a-zA-Z]:[\\/]') { throw '-SourceDir must be an absolute path on a local Windows drive.' }
    $SourceDir = [IO.Path]::GetFullPath($SourceDir).TrimEnd('\', '/')
    $root = [IO.Path]::GetPathRoot($SourceDir)
    $drive = [IO.DriveInfo]::new($root)
    if ($SourceDir -eq $root.TrimEnd('\', '/') -or $SourceDir -eq [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\', '/') -or $drive.DriveType -ne [IO.DriveType]::Fixed) {
        throw 'Use a separate source directory on a local Windows drive.'
    }
    # Reject junctions/symlinks before creating or trusting a source checkout.
    $cursor = $SourceDir
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The source path and its parents must not be junctions or symlinks.' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
    $stateBase = $env:LOCALAPPDATA
    if (-not $stateBase) { $stateBase = Join-Path $env:USERPROFILE 'AppData/Local' }
    $prospectiveInstall = $InstallDir
    if (-not $prospectiveInstall) { $prospectiveInstall = Join-Path $stateBase 'leo-multiplex-windows' }
    if ($prospectiveInstall -notmatch '^[a-zA-Z]:[\\/]') { throw '-InstallDir must be an absolute path on a local Windows drive.' }
    $forbidden = @($prospectiveInstall, (Join-Path $env:USERPROFILE '.codex'), (Join-Path $env:USERPROFILE '.copilot'))
    foreach ($forbiddenName in @('leo-multiplex', 'leo-multiplex-copilot', 'leo-multiplex-wsl')) { $forbidden += Join-Path $stateBase $forbiddenName }
    foreach ($path in $forbidden) {
        $target = [IO.Path]::GetFullPath($path).TrimEnd('\', '/')
        if ([string]::Equals($SourceDir, $target, [StringComparison]::OrdinalIgnoreCase) -or
            $SourceDir.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $target.StartsWith($SourceDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Keep the source checkout separate from host installation/state and existing native auth homes.'
        }
    }
    $repository = 'https://github.com/arduano/leo-multiplex.git'
    $gitDirectory = Join-Path $SourceDir '.git'
    $marker = Join-Path $gitDirectory 'leo-bootstrap-revision'
    $emptyHooks = Join-Path $gitDirectory 'leo-empty-hooks'
    function Invoke-Git {
        param([string[]]$Arguments)
        # Keep upstream diagnostics out of the handoff: they can contain local
        # credential-helper details. The repository URL itself is code-only.
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $output = & $git -c "core.hooksPath=$emptyHooks" @Arguments 2>$null; $code = $LASTEXITCODE }
        finally { $ErrorActionPreference = $previousPreference }
        if ($code -ne 0) { throw 'Git could not prepare or verify the pinned source. No host was started; the source was left in place.' }
        return ($output | Out-String).Trim()
    }
    if (Test-Path -LiteralPath $SourceDir) {
        if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container) -or -not (Test-Path -LiteralPath $marker -PathType Leaf)) {
            throw 'The source directory already exists and is not a bootstrap-owned checkout. Choose another -SourceDir; existing files were preserved.'
        }
        foreach ($path in @($gitDirectory, $marker)) {
            if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The source checkout has an unsafe link; existing files were preserved.' }
        }
        if ((Get-Content -LiteralPath $marker -Raw).Trim() -cne $Revision) { throw 'The source directory belongs to another revision. Choose another -SourceDir; the existing checkout was preserved.' }
    } else {
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($SourceDir))
        $null = New-Item -ItemType Directory -Path $SourceDir
        $null = Invoke-Git -Arguments @('-c', 'init.templateDir=', 'init', '--quiet', $SourceDir)
        $null = Invoke-Git -Arguments @('-C', $SourceDir, 'remote', 'add', 'origin', $repository)
        $null = Invoke-Git -Arguments @('-C', $SourceDir, 'fetch', '--quiet', '--depth=1', '--no-tags', 'origin', $Revision)
        if ((Invoke-Git -Arguments @('-C', $SourceDir, 'rev-parse', 'FETCH_HEAD^{commit}')) -cne $Revision) { throw 'Git returned a different commit; installation stopped.' }
        $null = Invoke-Git -Arguments @('-C', $SourceDir, 'checkout', '--quiet', '--detach', $Revision)
        [IO.File]::WriteAllText($marker, $Revision + "`n", [Text.UTF8Encoding]::new($false))
    }
    $actualRoot = [IO.Path]::GetFullPath((Invoke-Git -Arguments @('-C', $SourceDir, 'rev-parse', '--show-toplevel'))).TrimEnd('\', '/')
    if (-not [string]::Equals($actualRoot, $SourceDir, [StringComparison]::OrdinalIgnoreCase)) { throw 'The source directory is not the expected standalone checkout.' }
    if ((Invoke-Git -Arguments @('-C', $SourceDir, 'config', '--get', 'remote.origin.url')) -cne $repository) { throw 'The source repository changed; existing files were preserved.' }
    if ((Invoke-Git -Arguments @('-C', $SourceDir, 'rev-parse', 'HEAD')) -cne $Revision) { throw 'The source revision changed; existing files were preserved.' }
    if (Invoke-Git -Arguments @('-C', $SourceDir, 'status', '--porcelain', '--untracked-files=all')) { throw 'The source checkout has local changes; existing files were preserved.' }
    $parameters = @{ Revision = $Revision; Workspace = $Workspace; Name = $Name; GitHubHost = $GitHubHost; Check = $Check }
    if ($SecretFile) { $parameters.SecretFile = $SecretFile }
    if ($InstallDir) { $parameters.InstallDir = $InstallDir }
    Write-Output "Using pinned source: $SourceDir"
    & (Join-Path $SourceDir 'deploy/windows/install.ps1') @parameters
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
