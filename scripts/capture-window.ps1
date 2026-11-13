param([int]$ProcId, [string]$OutDir = "$PSScriptRoot")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$wins = New-Object System.Collections.ArrayList
$cb = [W+EnumProc]{ param($h,$l)
  $target = 0
  [W]::GetWindowThreadProcessId($h, [ref]$target) | Out-Null
  if ($target -eq $ProcId -and [W]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [W]::GetWindowTextW($h, $sb, 256) | Out-Null
    $r = New-Object W+RECT
    [W]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -gt 20 -and $hh -gt 20) { [void]$wins.Add(@{ H = $h; Title = $sb.ToString(); W = $w; Ht = $hh }) }
  }
  return $true
}
[W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$i = 0
foreach ($win in $wins) {
  $i++
  $bmp = New-Object System.Drawing.Bitmap $win.W, $win.Ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [W]::PrintWindow($win.H, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $safe = ($win.Title -replace '[^\w\-]', '_')
  if (-not $safe) { $safe = "win" }
  $path = Join-Path $OutDir ("capture-$i-$safe.png")
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "$path|$($win.Title)|$($win.W)x$($win.Ht)"
}
