param([int]$ProcId = 0)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class P0W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int sz);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
}
'@

$script:handles = New-Object System.Collections.ArrayList
$cb = [P0W+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$l)
  [void]$script:handles.Add($h)
  return $true
}
[void][P0W]::EnumWindows($cb, [IntPtr]::Zero)

function Get-Title([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][P0W]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}
function Get-Class([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][P0W]::GetClassName($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

$fg = [P0W]::GetForegroundWindow()
Write-Output ("foreground hwnd=0x{0:X} title={1}" -f $fg.ToInt64(), (Get-Title $fg))
Write-Output "z-order (visible top-level windows, top first):"
$z = 0
foreach ($h in $script:handles) {
  if (-not [P0W]::IsWindowVisible($h)) { continue }
  $t = Get-Title $h
  $p = 0
  [void][P0W]::GetWindowThreadProcessId($h, [ref]$p)
  if ($ProcId -ne 0 -and $p -ne $ProcId -and $t -eq "") { continue }
  if ($t -eq "" -and $p -ne $ProcId) { continue }
  $z++
  Write-Output ("  #{0} hwnd=0x{1:X} pid={2} class={3} title={4}" -f $z, $h.ToInt64(), $p, (Get-Class $h), $t)
}

foreach ($h in $script:handles) {
  $p = 0
  [void][P0W]::GetWindowThreadProcessId($h, [ref]$p)
  if ($ProcId -ne 0 -and $p -ne $ProcId) { continue }
  if (-not [P0W]::IsWindowVisible($h)) { continue }
  $t = Get-Title $h
  if ($t -eq "") { continue }
  $r = New-Object P0W+RECT
  [void][P0W]::GetWindowRect($h, [ref]$r)
  $ex = [P0W]::GetWindowLongPtr($h, -20).ToInt64()
  $st = [P0W]::GetWindowLongPtr($h, -16).ToInt64()
  $cloak = 0
  try { [void][P0W]::DwmGetWindowAttribute($h, 14, [ref]$cloak, 4) } catch {}
  $flags = @()
  if ($ex -band 0x08000000) { $flags += "WS_EX_NOACTIVATE" }
  if ($ex -band 0x00000080) { $flags += "WS_EX_TOOLWINDOW" }
  if ($ex -band 0x00000008) { $flags += "WS_EX_TOPMOST" }
  if ($ex -band 0x00040000) { $flags += "WS_EX_APPWINDOW" }
  if ($ex -band 0x00080000) { $flags += "WS_EX_LAYERED" }
  if ($ex -band 0x00000020) { $flags += "WS_EX_TRANSPARENT" }
  if ($st -band 0x10000000) { $flags += "WS_VISIBLE" }
  Write-Output ("window hwnd=0x{0:X} pid={1} title={2} class={3}" -f $h.ToInt64(), $p, $t, (Get-Class $h))
  Write-Output ("  style=0x{0:X8} exstyle=0x{1:X8} [{2}]" -f $st, $ex, ($flags -join ","))
  Write-Output ("  rect=({0},{1})-({2},{3}) size={4}x{5} iconic={6} cloaked={7}" -f $r.Left, $r.Top, $r.Right, $r.Bottom, ($r.Right-$r.Left), ($r.Bottom-$r.Top), [P0W]::IsIconic($h), $cloak)
}
