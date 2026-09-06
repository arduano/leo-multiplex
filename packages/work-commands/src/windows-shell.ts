import { win32 } from "node:path";

/** Pure invocation builder also exercised by native Windows smoke tests. Command bytes stay in a private file. */
export function windowsWorkCommandInvocation(commandFile: string, environment: NodeJS.ProcessEnv): { file: string; args: string[] } {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows";
  if (!win32.isAbsolute(systemRoot)) throw new Error("Windows SystemRoot must be absolute");
  const escapedFile = commandFile.replaceAll("'", "''");
  // The kernel job owns descendants even if the shell exits first or loses its
  // controller. Without KILL_ON_JOB_CLOSE, taskkill cannot find orphaned children.
  // Fail closed if corporate process restrictions prevent assignment to this job.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LeoWorkCommandJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic BasicLimitInformation; public Io IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr job;
  public static void Enter() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("Cannot create command process job");
    Extended limits = new Extended(); limits.BasicLimitInformation.LimitFlags = 0x2000;
    int size = Marshal.SizeOf(typeof(Extended)); IntPtr pointer = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, pointer, false);
      if (!SetInformationJobObject(job, 9, pointer, (uint)size) || !AssignProcessToJobObject(job, GetCurrentProcess()))
        throw new Exception("Cannot secure command process job");
    } finally { Marshal.FreeHGlobal(pointer); }
  }
}
'@
[LeoWorkCommandJob]::Enter()
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = $null
& ([ScriptBlock]::Create([IO.File]::ReadAllText('${escapedFile}')))
$leoCommandSucceeded = $?
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
if (-not $leoCommandSucceeded) { exit 1 }
exit 0
`;
  return {
    file: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}
