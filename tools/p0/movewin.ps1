param(
  [Parameter(Mandatory=$true)][int]$ProcId,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][int]$W,
  [Parameter(Mandatory=$true)][int]$H
)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MW {
  [DllImport("user32.dll")] public static extern bool EnumWindows(E cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public delegate bool E(IntPtr h, IntPtr l);
}
'@

$script:handles = New-Object System.Collections.ArrayList
$cb = [MW+E]{
  param([IntPtr]$h, [IntPtr]$l)
  $p = 0
  [void][MW]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $ProcId) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][MW]::GetWindowText($h, $sb, 256)
    if ([MW]::IsWindowVisible($h) -and $sb.ToString() -ne "") { [void]$script:handles.Add($h) }
  }
  return $true
}
[void][MW]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($h in $script:handles) {
  [void][MW]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0040)
  Write-Output ("moved 0x{0:X} to {1},{2} {3}x{4}" -f $h.ToInt64(), $X, $Y, $W, $H)
}
