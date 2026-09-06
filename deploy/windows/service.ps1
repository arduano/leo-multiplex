<#
.SYNOPSIS
Runs an existing Leo Windows host as a background task for the current user.
.DESCRIPTION
Install adds a least-privilege Task Scheduler entry for sign-in. It needs no
password or elevation and preserves the pinned host installation and auth state.
StartNow begins waiting for an existing foreground host to stop cleanly. Stop
requests cooperative shutdown; it never ends a task or kills a process.
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Remove')][string]$Action = 'Install',
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'leo-multiplex-windows'),
    [string]$RunnerPath = (Join-Path $PSScriptRoot '../../scripts/windows-user-service.mjs'),
    [switch]$StartNow
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Node {
    param([string[]]$Arguments)
    & $script:node @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'The private service helper failed. No process was force-stopped.' }
}
function Resolve-UserSid([string]$Identity) {
    if ($Identity -match '^S-1-') { return $Identity }
    return ([Security.Principal.NTAccount]::new($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Test-OwnedTask {
    param($Task)
    if (-not $Task) { return }
    $principalSid = Resolve-UserSid $Task.Principal.UserId
    if ($principalSid -ne $script:sid -or [string]$Task.Principal.LogonType -ne 'Interactive' -or
        [string]$Task.Principal.RunLevel -ne 'Limited' -or @($Task.Actions).Count -ne 1 -or
        -not [string]::Equals($Task.Actions[0].Execute, $script:powershell, [StringComparison]::OrdinalIgnoreCase) -or
        $Task.Actions[0].Arguments -cne $script:taskArguments -or
        -not [string]::Equals($Task.Actions[0].WorkingDirectory, $script:InstallDir, [StringComparison]::OrdinalIgnoreCase) -or
        @($Task.Triggers).Count -ne 1 -or $Task.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or
        (Resolve-UserSid $Task.Triggers[0].UserId) -ne $script:sid -or [string]$Task.Settings.MultipleInstances -ne 'IgnoreNew' -or
        $Task.Settings.DisallowStartIfOnBatteries -or $Task.Settings.StopIfGoingOnBatteries -or
        [Xml.XmlConvert]::ToTimeSpan($Task.Settings.ExecutionTimeLimit) -ne [TimeSpan]::Zero) {
        throw 'A different task already uses this name. Existing tasks were preserved.'
    }
}
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Use this command in native Windows PowerShell.' }
    if ($StartNow -and $Action -ne 'Install') { throw '-StartNow is only valid with -Action Install.' }
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\', '/')
    if ($InstallDir -notmatch '^[a-zA-Z]:[\\/]' -or $InstallDir.Contains('"')) { throw 'Use the existing installation on a local Windows drive.' }
    $config = Get-Content -LiteralPath (Join-Path $InstallDir 'host-install.json') -Raw | ConvertFrom-Json
    if ($config.version -ne 1 -or $config.platform -ne 'windows' -or $config.environment.LEO_HARNESS -ne 'copilot' -or
        -not [string]::Equals($config.installDirectory, $InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'An existing Windows Copilot installation is required.'
    }
    $name = [string]$config.environment.LEO_HOST_NAME
    if (-not $name -or $name -match '[\\/:*?"<>|\[\]\x00-\x1f]' -or $name.Length -gt 100) { throw 'The host name cannot be used as a scheduled task name.' }
    $taskName = 'Leo Multiplex - ' + $name
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $runner = Join-Path $InstallDir 'service/runner.mjs'
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $escapedNode = $node.Replace("'", "''")
    $escapedRunner = $runner.Replace("'", "''")
    $command = "& '$escapedNode' '$escapedRunner' run; exit `$LASTEXITCODE"
    $taskArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $command + '"'
    $task = Get-ScheduledTask -TaskPath '\' | Where-Object { $_.TaskName -eq $taskName }
    Test-OwnedTask $task
    if ($Action -eq 'Install') {
        Invoke-Node -Arguments @([IO.Path]::GetFullPath($RunnerPath), 'prepare', $InstallDir)
        $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $taskArguments -WorkingDirectory $InstallDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
        $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        $description = 'Leo Multiplex Windows host. Current user only; enrollment closed. Use the private runner stop command for graceful shutdown.'
        if (-not $task) {
            $null = Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $taskAction -Trigger $trigger `
                -Principal $principal -Settings $settings -Description $description
        }
        Test-OwnedTask (Get-ScheduledTask -TaskName $taskName -TaskPath '\')
        Write-Output 'User task installed. It starts at sign-in and runs while this account is signed in, including while locked.'
        if ($StartNow) {
            Start-ScheduledTask -TaskName $taskName -TaskPath '\'
            Write-Output 'Background task started. If the foreground host is open, press Ctrl+C there once for a clean handoff.'
        }
    } elseif ($Action -eq 'Start') {
        if (-not $task) { throw 'Install the user task first.' }
        Start-ScheduledTask -TaskName $taskName -TaskPath '\'
        Write-Output 'Background task start requested.'
    } elseif ($Action -eq 'Stop') {
        if (-not $task) { throw 'The user task is not installed.' }
        Invoke-Node -Arguments @($runner, 'stop')
    } elseif ($Action -eq 'Status') {
        [pscustomobject]@{ TaskName = $taskName; Installed = [bool]$task; State = $(if ($task) { [string]$task.State } else { 'NotInstalled' }) } | ConvertTo-Json -Compress
        if (Test-Path -LiteralPath $runner) { Invoke-Node -Arguments @($runner, 'status') }
    } elseif ($Action -eq 'Remove') {
        if ($task -and [string]$task.State -in @('Running', 'Queued')) { throw 'Request Stop and wait for the task to finish before removing it.' }
        if ($task) { Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false }
        Write-Output 'User task removed. Host installation, service files, identity and sign-in state were preserved.'
    }
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
