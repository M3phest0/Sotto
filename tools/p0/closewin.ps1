param(
  [Parameter(Mandatory=$true)][int]$ProcId,
  [Parameter(Mandatory=$true)][string]$Title,
  [string]$SkipExact = ''
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CW {
  [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  public delegate bool E(IntPtr h, IntPtr l);
}
'@

$script:hits = New-Object System.Collections.ArrayList
$cb = [CW+E]{
  param([IntPtr]$h, [IntPtr]$l)
  $p = 0
  [void][CW]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $ProcId) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][CW]::GetWindowText($h, $sb, 256)
    $t = $sb.ToString()
    if ([CW]::IsWindowVisible($h) -and $t.Contains($Title) -and ($SkipExact -eq '' -or $t -ne $SkipExact)) { [void]$script:hits.Add($h) }
  }
  return $true
}
[void][CW]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($win in $script:hits) {
  [void][CW]::PostMessage($win, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  Write-Output ("WM_CLOSE 0x{0:X}" -f [long]$win)
}
