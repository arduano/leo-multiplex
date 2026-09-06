# Native Task Scheduler qualification using disposable fixture state only.
# No Copilot login, model calls, installed laptop state or other tasks are used.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true') {
    throw 'Run this disposable scheduler smoke on a Windows GitHub Actions runner.'
}
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$installer = Join-Path $repoRoot 'deploy\windows\service.ps1'
$runnerSource = Join-Path $repoRoot 'scripts\windows-user-service.mjs'
$fixtureRoot = Join-Path $env:RUNNER_TEMP ('leo-user-task-' + [guid]::NewGuid().ToString('N'))
$installation = Join-Path $fixtureRoot "private installation's"
$fixtureScript = Join-Path $fixtureRoot 'fixture.mjs'
$hostName = 'service-smoke-' + [guid]::NewGuid().ToString('N')
$taskName = 'Leo Multiplex - ' + $hostName
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$checks = [Collections.Generic.List[string]]::new()
$heldProcess = $null
$ownedTask = $false
$finished = $false
$utf8 = [Text.UTF8Encoding]::new($false)
$qualificationIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$qualificationPrincipal = [Security.Principal.WindowsPrincipal]::new($qualificationIdentity)
$registrationElevated = $qualificationPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$uacEnabled = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA).EnableLUA -ne 0
$scheduledElevated = $null
$null = New-Item -ItemType Directory -Path $fixtureRoot

function Assert-That([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Wait-Until([scriptblock]$Condition, [string]$Message, [int]$Seconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 200
    }
    throw $Message
}

function Invoke-Service([string]$Action, [switch]$ExpectFailure) {
    $arguments = @('-NoProfile', '-NonInteractive', '-File', $installer, '-Action', $Action,
        '-InstallDir', $installation, '-RunnerPath', $runnerSource)
    $savedPreference = $ErrorActionPreference
    try {
        # Windows PowerShell wraps native stderr in ErrorRecords. Preserve the
        # explicit exit-code assertion for the expected active-remove failure.
        $ErrorActionPreference = 'Continue'
        $output = @(& $powershell @arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($ExpectFailure) {
        Assert-That ($code -ne 0) "Service $Action unexpectedly succeeded."
    } else {
        if ($code -ne 0) { Write-Host ($output -join "`n") }
        Assert-That ($code -eq 0) "Service $Action failed (exit $code)."
    }
    return ($output -join "`n")
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { return $null } # Atomic replacement can be momentarily unavailable on Windows.
}

function Resolve-Sid([string]$Identity) {
    if ($Identity -match '^S-1-') { return $Identity }
    return ([Security.Principal.NTAccount]::new($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value
}

# The fixture uses the exact installed framework's ACL helper and writer-lock
# probe. Only its launcher is replaced: it records native process context and
# waits for graceful SIGINT, never importing the agent management entrypoint.
$fixture = @'
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFile, stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, source, installation, hostName, installer] = process.argv.slice(2);
const helper = await import(pathToFileURL(join(source, 'dist/apps/host/src/private-state.js')).href);
const state = join(installation, 'state');
const configPath = join(installation, 'host-install.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

if (mode === 'setup') {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  await helper.privateDirectory(installation);
  await helper.privateDirectory(state);
  const config = {
    version: 1, platform: 'windows', sourceRoot: source, revision,
    frameworkVersion: '0.2.1', installDirectory: installation,
    environment: {
      LEO_HARNESS: 'copilot', LEO_STATE_DIR: state, LEO_HOST_NAME: hostName,
      LEO_ALLOWED_ROOTS: '"*"', LEO_COPILOT_GITHUB_HOST: 'github.com',
      LEO_CONTROL_HTTP_PORT: '4317', LEO_CONTROL_P2P_BIND: '0.0.0.0:49117',
      LEO_ENROLL_GATEWAYS: '0', LEO_ENROLL_RUNTIMES: '0',
    },
  };
  await helper.writePrivateFile(configPath, JSON.stringify(config));
  await helper.writePrivateFile(join(state, 'fixture-auth-sentinel'), 'preserve-existing-native-auth-state\n');
  await helper.writePrivateFile(join(state, 'shared-secret'), 'disposable-service-qualification-value-123456789\n');
  await helper.writePrivateFile(join(installation, 'leo-host.mjs'), `
export { installedEnvironment } from ${JSON.stringify(pathToFileURL(join(source, 'scripts/installed-copilot-host.mjs')).href)};
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function main(args, installation = dirname(fileURLToPath(import.meta.url))) {
  assert.deepEqual(args, ['start']);
  const config = JSON.parse(await readFile(join(installation, 'host-install.json'), 'utf8'));
  const helper = await import(pathToFileURL(join(config.sourceRoot, 'dist/apps/host/src/private-state.js')).href);
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const token = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($identity); @{ sid = $identity.User.Value; elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress'
  ], { encoding: 'utf8', windowsHide: true }));
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  process.once('SIGINT', stop);
  await helper.writePrivateFile(join(installation, 'fixture-running.json'), JSON.stringify({ args, token, pid: process.pid }));
  await stopped;
  process.removeListener('SIGINT', stop);
  await helper.writePrivateFile(join(installation, 'fixture-stopped.json'), JSON.stringify({ graceful: true, pid: process.pid }));
}
`);
} else if (mode === 'hold') {
  const lockDirectory = join(state, 'control');
  await helper.privateDirectory(lockDirectory);
  const database = new DatabaseSync(join(lockDirectory, 'catalog.sqlite.lock.sqlite'));
  database.exec('CREATE TABLE IF NOT EXISTS fixture (value INTEGER); BEGIN EXCLUSIVE; INSERT INTO fixture VALUES (1);');
  await helper.writePrivateFile(join(installation, 'fixture-lock-held.json'), '{}');
  try {
    const deadline = Date.now() + 120_000;
    while (!await stat(join(installation, 'fixture-release-lock')).catch(() => null)) {
      if (Date.now() > deadline) throw new Error('Fixture lock release timed out');
      await delay(100);
    }
  } finally { database.exec('ROLLBACK'); database.close(); }
} else if (mode === 'start-in-job') {
  const { windowsWorkCommandInvocation } = await import(pathToFileURL(join(source, 'dist/packages/work-commands/src/windows-shell.js')).href);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const commandFile = join(installation, 'fixture-start.command');
  const powershell = win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await helper.writePrivateFile(commandFile, '& ' + quote(powershell) + ' -NoProfile -NonInteractive -File ' + quote(installer) + ' -Action Start -InstallDir ' + quote(installation));
  const invocation = windowsWorkCommandInvocation(commandFile, process.env);
  const result = spawnSync(invocation.file, invocation.args, { windowsHide: true, encoding: 'utf8', timeout: 45_000 });
  if (result.status !== 0) process.stderr.write((result.stdout ?? '') + (result.stderr ?? ''));
  assert.equal(result.status, 0, 'Scheduler start from the real recovery-command process job failed');
} else if (mode === 'verify-private') {
  for (const file of ['runner.mjs', 'status.json']) await helper.verifyPrivateTarget(join(installation, 'service', file));
} else { throw new Error('Unknown fixture command'); }
'@
[IO.File]::WriteAllText($fixtureScript, $fixture, $utf8)

try {
    & $node $fixtureScript setup $repoRoot $installation $hostName $installer
    Assert-That ($LASTEXITCODE -eq 0) 'Private fixture creation failed.'
    $configHash = (Get-FileHash -LiteralPath (Join-Path $installation 'host-install.json') -Algorithm SHA256).Hash
    $sentinel = Join-Path $installation 'state\fixture-auth-sentinel'
    $sentinelHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
    Assert-That ($null -eq (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue)) 'Disposable task name already exists.'

    $null = Invoke-Service Install
    $ownedTask = $true
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
    Assert-That (@($task.Actions).Count -eq 1) 'Service must have exactly one action.'
    Assert-That (@($task.Triggers).Count -eq 1) 'Service must have exactly one logon trigger.'
    Assert-That ($task.Principal.LogonType.ToString() -eq 'Interactive') 'Task must use the existing interactive token.'
    Assert-That ($task.Principal.RunLevel.ToString() -eq 'Limited') 'Task must not request elevated privileges.'
    Assert-That ((Resolve-Sid $task.Principal.UserId) -eq $currentSid) 'Task principal differs from the installing user.'
    Assert-That ((Resolve-Sid $task.Triggers[0].UserId) -eq $currentSid) 'Logon trigger differs from the installing user.'
    Assert-That ($task.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') 'Task must be triggered by user logon.'
    Assert-That ($task.Actions[0].Execute -eq $powershell) 'Task executable must be system Windows PowerShell.'
    $runner = Join-Path $installation 'service\runner.mjs'
    $quotedNode = $node.Replace("'", "''")
    $quotedRunner = $runner.Replace("'", "''")
    $expectedCommand = "& '$quotedNode' '$quotedRunner' run; exit `$LASTEXITCODE"
    $expectedArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $expectedCommand + '"'
    Assert-That ($task.Actions[0].Arguments -eq $expectedArguments) 'Hidden task must invoke only the exact installed Node path and service runner.'
    Assert-That ($task.Actions[0].WorkingDirectory -eq $installation) 'Task must have the explicit installation working directory.'
    Assert-That ($task.Actions[0].Arguments -notmatch '--enroll') 'Scheduled startup must not enable enrollment.'
    Assert-That ($task.Settings.MultipleInstances.ToString() -eq 'IgnoreNew') 'Task must reject overlapping instances.'
    Assert-That (-not $task.Settings.DisallowStartIfOnBatteries -and -not $task.Settings.StopIfGoingOnBatteries) 'Battery transitions must not stop the host.'
    Assert-That ([Xml.XmlConvert]::ToTimeSpan($task.Settings.ExecutionTimeLimit) -eq [TimeSpan]::Zero) 'Service must not have a default execution time limit.'
    Assert-That ($task.Settings.RestartCount -ge 1 -and $task.Settings.RestartCount -le 5) 'Crash restart count must be bounded.'
    Assert-That (-not $task.Settings.RunOnlyIfIdle -and -not $task.Settings.RunOnlyIfNetworkAvailable) 'Task startup must not wait for idle or a network profile.'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $installation 'fixture-running.json'))) 'Installing the task must not start an agent host.'
    $checks.Add('Own-user Interactive Limited logon task, exact action, no enrollment, no timeout or battery stop, bounded restarts')

    $before = Export-ScheduledTask -TaskName $taskName -TaskPath '\'
    $null = Invoke-Service Install
    $after = Export-ScheduledTask -TaskName $taskName -TaskPath '\'
    Assert-That ($before -eq $after) 'Same-installation rerun must retain the exact existing task.'
    $checks.Add('Idempotent registration preserves the task identity and definition')

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.Arguments = '"' + $fixtureScript + '" hold "' + $repoRoot + '" "' + $installation + '" "' + $hostName + '" "' + $installer + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $heldProcess = [Diagnostics.Process]::Start($start)
    Wait-Until { Test-Path -LiteralPath (Join-Path $installation 'fixture-lock-held.json') } 'Disposable foreground writer did not acquire its lock.'
    & $node $fixtureScript start-in-job $repoRoot $installation $hostName $installer
    Assert-That ($LASTEXITCODE -eq 0) 'Recovery-command scheduler handoff failed.'
    Wait-Until {
        $status = Read-JsonFile (Join-Path $installation 'service\status.json')
        $null -ne $status -and $status.state -eq 'waiting-for-foreground'
    } 'Interactive task did not run and wait for the foreground writer. Do not replace InteractiveToken with a service logon to make CI pass.'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $installation 'fixture-running.json'))) 'Task started a second host while foreground writer remained active.'
    $checks.Add('Task survives the real recovery-command kill-on-close job and waits for foreground writer release')

    [IO.File]::WriteAllText((Join-Path $installation 'fixture-release-lock'), '', $utf8)
    Assert-That ($heldProcess.WaitForExit(10000)) 'Disposable foreground writer did not release cleanly.'
    Assert-That ($heldProcess.ExitCode -eq 0) 'Disposable foreground writer failed.'
    Wait-Until { $null -ne (Read-JsonFile (Join-Path $installation 'fixture-running.json')) } 'Scheduled fixture launcher did not start after writer release.'
    $running = Read-JsonFile (Join-Path $installation 'fixture-running.json')
    Assert-That (@($running.args).Count -eq 1 -and $running.args[0] -eq 'start') 'Installed launcher must receive plain start only.'
    Assert-That ($running.token.sid -eq $currentSid) 'Scheduled launcher must run as the same user.'
    $scheduledElevated = [bool]$running.token.elevated
    # Hosted runners start with an admin token and may retain it even with
    # Limited task configuration. Prove same-user/no privilege escalation and
    # report the actual token; a standard-user registration is checked on the
    # laptop separately. Never change account/UAC policy just to satisfy CI.
    Assert-That (-not $scheduledElevated -or $registrationElevated) 'Task elevated a non-administrator caller.'
    if ($scheduledElevated) {
        $checks.Add('Hosted runner retains its existing admin token with Limited configuration; actual token is recorded, standard-user laptop check is separate')
    }
    $initialPid = $running.pid
    $null = Invoke-Service Start
    $null = Invoke-Service Remove -ExpectFailure
    Assert-That ((Read-JsonFile (Join-Path $installation 'fixture-running.json')).pid -eq $initialPid) 'Repeated start must preserve the one existing host.'
    Assert-That ($null -ne (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue)) 'Removal must refuse an active host.'
    $checks.Add('Foreground handoff launches plain start as the same account with Limited task configuration; duplicate start and active removal cannot replace it')

    $null = Invoke-Service Stop
    Wait-Until {
        $marker = Read-JsonFile (Join-Path $installation 'fixture-stopped.json')
        $null -ne $marker -and $marker.graceful -and $marker.pid -eq $initialPid
    } 'Service stop did not reach the exact fixture launcher graceful SIGINT handler.'
    Wait-Until { (Get-ScheduledTask -TaskName $taskName -TaskPath '\').State.ToString() -ne 'Running' } 'Task did not exit after graceful stop.'
    $statusOutput = @(& $node $runner status)
    Assert-That ($LASTEXITCODE -eq 0) 'Installed service runner status failed.'
    $stoppedStatus = ($statusOutput -join "`n") | ConvertFrom-Json
    Assert-That ($stoppedStatus.state -eq 'stopped') 'Service status must report the graceful stop.'
    & $node $fixtureScript verify-private $repoRoot $installation $hostName $installer
    Assert-That ($LASTEXITCODE -eq 0) 'Service state or runner ACL verification failed.'
    $checks.Add('Owner-only graceful stop exits the exact task and keeps bounded status/runner files private')

    $null = Invoke-Service Remove
    $ownedTask = $false
    Assert-That ($null -eq (Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue)) 'Remove retained the owned scheduler task.'
    Assert-That ((Get-FileHash -LiteralPath (Join-Path $installation 'host-install.json') -Algorithm SHA256).Hash -eq $configHash) 'Service lifecycle changed installed source, identity or configuration.'
    Assert-That ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -eq $sentinelHash) 'Service lifecycle changed preserved native auth/state.'
    $checks.Add('Removal unregisters only its own stopped task and preserves installed configuration/auth/state')
    $finished = $true
} finally {
    if ($null -ne $heldProcess -and -not $heldProcess.HasExited) {
        [IO.File]::WriteAllText((Join-Path $installation 'fixture-release-lock'), '', $utf8)
        $null = $heldProcess.WaitForExit(10000)
    }
    if ($ownedTask) {
        # Cleanup is restricted to this random fixture task, never an installed host.
        try { $null = Invoke-Service Stop } catch { Write-Warning 'Fixture graceful-stop request failed during cleanup.' }
        try {
            Wait-Until { (Get-ScheduledTask -TaskName $taskName -TaskPath '\').State.ToString() -ne 'Running' } 'Fixture task did not stop during cleanup.' 15
        } catch {
            Stop-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
        }
        Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction SilentlyContinue
    }
    if ($null -ne $heldProcess) { $heldProcess.Dispose() }
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Assert-That $finished 'Native user-service smoke did not complete.'
$personalSource = (& git -C $repoRoot rev-parse HEAD).Trim()
Assert-That ($LASTEXITCODE -eq 0) 'Cannot identify qualified source.'
$dirty = @(& git -C $repoRoot status --porcelain --untracked-files=no)
Assert-That ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'Native qualification requires unchanged exact tracked source.'
$receipt = [ordered]@{
    result = 'passed'
    personalSource = $personalSource
    personalLockSha256 = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    checks = $checks.ToArray()
    registrationCallerElevated = $registrationElevated
    uacEnabled = $uacEnabled
    scheduledProcessElevated = $scheduledElevated
    scheduledLauncherElevated = $false
    modelCalls = 0
    nativeSessionsCreated = 0
    retainedCredentials = $false
    disposableStateRemoved = -not (Test-Path -LiteralPath $fixtureRoot)
    scope = 'Native own-user Windows Task Scheduler with published private-state helper and fixture launcher; registration caller elevation recorded, corporate policy, physical logon/suspend and real provider UAT excluded'
}
$receiptDirectory = Join-Path $repoRoot ('receipts\windows-user-service\' + [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss.fffZ'))
$null = New-Item -ItemType Directory -Path $receiptDirectory -Force
$receiptPath = Join-Path $receiptDirectory 'receipt.json'
$encoded = ($receipt | ConvertTo-Json -Depth 8) + "`n"
[IO.File]::WriteAllText($receiptPath, $encoded, $utf8)
$digest = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $receiptDirectory 'SHA256SUMS'), "$digest  receipt.json`n", $utf8)
Write-Output $encoded
