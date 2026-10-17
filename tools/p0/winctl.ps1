param(
  [Parameter(Mandatory=$true)][ValidateSet('minimize','restore','foreground')][string]$Action,
  [Parameter(Mandatory=$true)][int]$ProcId
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class P0C {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
}
'@

$script:found = New-Object System.Collections.ArrayList
$cb = [P0C+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$l)
  $p = 0
  [void][P0C]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $ProcId -and [P0C]::IsWindowVisible($h)) { [void]$script:found.Add($h) }
  return $true
}
[void][P0C]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($h in $script:found) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][P0C]::GetWindowText($h, $sb, $sb.Capacity)
  switch ($Action) {
    'minimize' { [void][P0C]::ShowWindow($h, 6) }
    'restore' { [void][P0C]::ShowWindow($h, 9) }
    'foreground' { [void][P0C]::SetForegroundWindow($h) }
  }
  Write-Output ("{0} hwnd=0x{1:X} title={2}" -f $Action, $h.ToInt64(), $sb.ToString())
}
