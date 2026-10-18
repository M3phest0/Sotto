param(
  [Parameter(Mandatory=$true)][int]$ProcId,
  [Parameter(Mandatory=$true)][string]$Title,
  [string]$SkipExact = '',
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][int]$W,
  [Parameter(Mandatory=$true)][int]$H
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MW1 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool E(IntPtr h, IntPtr l);
}
'@
[void][MW1]::SetProcessDPIAware()

$script:hits = New-Object System.Collections.ArrayList
$cb = [MW1+E]{
  param([IntPtr]$h, [IntPtr]$l)
  $p = 0
  [void][MW1]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $ProcId) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][MW1]::GetWindowText($h, $sb, 256)
    $t = $sb.ToString()
    if ([MW1]::IsWindowVisible($h) -and $t.Contains($Title) -and ($SkipExact -eq '' -or $t -ne $SkipExact)) { [void]$script:hits.Add($h) }
  }
  return $true
}
[void][MW1]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($win in $script:hits) {
  [void][MW1]::SetWindowPos($win, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0040)
  Write-Output ("moved 0x{0:X} to {1},{2} {3}x{4}" -f [long]$win, $X, $Y, $W, $H)
}
