<#
Private own-user WSL background task for the already installed host.
Copy the reviewed shell helper privately to the exact Linux path below first.
Enrollment uses a separate on-demand task without sign-in or retry triggers.
The production task always starts with enrollment closed.
#>
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Start', 'Enroll', 'Stop', 'Status', 'Remove')]
    [string]$Action = 'Status'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$distribution = 'Ubuntu'
$linuxUser = 'arduano'
$linuxHelper = '/home/arduano/.local/state/leo-multiplex-wsl/service/wsl-user-service.sh'
$taskName = 'Leo Multiplex - work-wsl'
$enrollmentTaskName = 'Leo Multiplex - work-wsl enrollment'

function Resolve-UserSid([string]$Identity) {
    if ($Identity -match '^S-1-') { return $Identity }
    return ([Security.Principal.NTAccount]::new($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
}
function Get-Task([string]$Name) {
    return Get-ScheduledTask -TaskPath '\' | Where-Object { $_.TaskName -ceq $Name }
}
function Get-TaskArguments([string]$Command) {
    $values = @($script:wsl, '--distribution', $script:distribution, '--user', $script:linuxUser,
                '--exec', '/usr/bin/bash', $script:linuxHelper, $Command)
    $quoted = $values | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
    $invoke = '& ' + ($quoted -join ' ') + '; exit $LASTEXITCODE'
    return '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $invoke + '"'
}
function Assert-OwnedTask($Task, [bool]$Enrollment) {
    if (-not $Task) { return }
    $expectedCommand = $(if ($Enrollment) { 'run-enrollment' } else { 'run' })
    $expectedTriggerCount = $(if ($Enrollment) { 0 } else { 1 })
    if ((Resolve-UserSid $Task.Principal.UserId) -ne $script:sid -or
        [string]$Task.Principal.LogonType -ne 'Interactive' -or
        [string]$Task.Principal.RunLevel -ne 'Limited' -or
        @($Task.Actions).Count -ne 1 -or
        -not [string]::Equals($Task.Actions[0].Execute, $script:powershell, [StringComparison]::OrdinalIgnoreCase) -or
        $Task.Actions[0].Arguments -cne (Get-TaskArguments $expectedCommand) -or
        @($Task.Triggers | Where-Object { $null -ne $_ }).Count -ne $expectedTriggerCount -or
        [string]$Task.Settings.MultipleInstances -ne 'IgnoreNew' -or
        $Task.Settings.DisallowStartIfOnBatteries -or $Task.Settings.StopIfGoingOnBatteries -or
        [Xml.XmlConvert]::ToTimeSpan($Task.Settings.ExecutionTimeLimit) -ne [TimeSpan]::Zero) {
        throw 'A different task uses this name; all existing tasks were preserved.'
    }
    if (-not $Enrollment -and
        ($Task.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or
         (Resolve-UserSid $Task.Triggers[0].UserId) -ne $script:sid)) {
        throw 'A different task trigger uses this name; all existing tasks were preserved.'
    }
    if ($Enrollment -and $Task.Settings.RestartCount -ne 0) {
        throw 'Enrollment must never automatically retry.'
    }
}
function Invoke-Linux([string]$Command) {
    & $script:wsl --distribution $script:distribution --user $script:linuxUser --exec /usr/bin/bash $script:linuxHelper $Command
    if ($LASTEXITCODE -ne 0) { throw "WSL service $Command failed (exit $LASTEXITCODE); no process was force-stopped." }
}
function Register-OwnTask([bool]$Enrollment) {
    $name = $(if ($Enrollment) { $script:enrollmentTaskName } else { $script:taskName })
    $command = $(if ($Enrollment) { 'run-enrollment' } else { 'run' })
    $existing = Get-Task $name
    Assert-OwnedTask $existing $Enrollment
    if (-not $existing) {
        $settingsArgs = @{
            MultipleInstances = 'IgnoreNew'
            ExecutionTimeLimit = [TimeSpan]::Zero
            AllowStartIfOnBatteries = $true
            DontStopIfGoingOnBatteries = $true
        }
        if (-not $Enrollment) {
            $settingsArgs['StartWhenAvailable'] = $true
            $settingsArgs['RestartCount'] = 3
            $settingsArgs['RestartInterval'] = New-TimeSpan -Minutes 1
        }
        $registration = @{
            TaskName = $name
            TaskPath = '\'
            Action = New-ScheduledTaskAction -Execute $script:powershell -Argument (Get-TaskArguments $command)
            Principal = New-ScheduledTaskPrincipal -UserId $script:sid -LogonType Interactive -RunLevel Limited
            Settings = New-ScheduledTaskSettingsSet @settingsArgs
            Description = $(if ($Enrollment) { 'Leo work-wsl initial enrollment only. On-demand; no sign-in trigger or retries.' }
                            else { 'Leo work-wsl host for the current signed-in user. Enrollment closed; Linux systemd owns graceful stop.' })
        }
        if (-not $Enrollment) { $registration['Trigger'] = New-ScheduledTaskTrigger -AtLogOn -User $script:sid }
        $null = Register-ScheduledTask @registration
    }
    Assert-OwnedTask (Get-Task $name) $Enrollment
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'Use native Windows PowerShell as the signed-in account.' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $wsl = Join-Path $env:SystemRoot 'System32/wsl.exe'
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if (-not (Test-Path -LiteralPath $wsl -PathType Leaf)) { throw 'Existing Windows WSL installation required.' }
    $task = Get-Task $taskName
    $enrollment = Get-Task $enrollmentTaskName
    Assert-OwnedTask $task $false
    Assert-OwnedTask $enrollment $true
    switch ($Action) {
        'Install' {
            Invoke-Linux 'check'
            Register-OwnTask $false
            Write-Output 'WSL own-user sign-in task installed. No host was started.'
        }
        'Start' {
            if (-not $task) { throw 'Install the production task first.' }
            if ($enrollment -and [string]$enrollment.State -in @('Running', 'Queued')) {
                throw 'Stop the enrollment host gracefully and wait for its task to finish before normal startup.'
            }
            Start-ScheduledTask -TaskName $taskName -TaskPath '\'
            Write-Output 'Normal WSL background startup requested; enrollment remains closed.'
        }
        'Enroll' {
            if ($task -and [string]$task.State -in @('Running', 'Queued')) {
                throw 'The production host is already active; no enrollment host was started.'
            }
            Invoke-Linux 'check'
            Register-OwnTask $true
            Start-ScheduledTask -TaskName $enrollmentTaskName -TaskPath '\'
            Write-Output 'Initial enrollment requested in a separate on-demand task. After pairing, use Stop, then Start.'
        }
        'Stop' {
            Invoke-Linux 'stop'
            Write-Output 'Graceful stop completed. Allow the foreground WSL task to finish before starting again.'
        }
        'Status' {
            foreach ($name in @($taskName, $enrollmentTaskName)) {
                $current = Get-Task $name
                if ($current) {
                    $info = Get-ScheduledTaskInfo -TaskName $name -TaskPath '\'
                    [pscustomobject]@{ TaskName = $name; State = [string]$current.State; LastRunTime = $info.LastRunTime; LastTaskResult = $info.LastTaskResult } | ConvertTo-Json -Compress
                }
            }
            Invoke-Linux 'status'
        }
        'Remove' {
            $activeTasks = @(@($task, $enrollment) | Where-Object { $_ -and [string]$_.State -in @('Running', 'Queued') })
            if ($activeTasks.Count -gt 0) {
                throw 'Stop and wait for both WSL tasks to finish before removing them.'
            }
            foreach ($current in @($task, $enrollment)) {
                if ($current) { Unregister-ScheduledTask -TaskName $current.TaskName -TaskPath '\' -Confirm:$false }
            }
            Write-Output 'Only the two owned WSL tasks were removed. Installation, state, corporate sign-in and Windows service were preserved.'
        }
    }
} catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
