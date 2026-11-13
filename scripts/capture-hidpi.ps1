param([int]$ProcId, [string]$OutDir = "$PSScriptRoot")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class C {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, Ri, B; }
}
"@
[C]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$script:wins = New-Object System.Collections.ArrayList
$cb = [C+EnumProc]{ param($h, $l)
  $p = 0
  [C]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq $ProcId -and [C]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [C]::GetWindowTextW($h, $sb, 256) | Out-Null
    $r = New-Object C+RECT
    [C]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Ri - $r.L; $hh = $r.B - $r.T
    if ($w -gt 20 -and $hh -gt 20) { [void]$script:wins.Add(@{ H = $h; Title = $sb.ToString(); W = $w; Ht = $hh }) }
  }
  return $true
}
[C]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$i = 0
foreach ($win in $script:wins) {
  $i++
  $bmp = New-Object System.Drawing.Bitmap $win.W, $win.Ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [C]::PrintWindow($win.H, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc); $g.Dispose()
  $path = Join-Path $OutDir ("hidpi-$i-$($win.W)x$($win.Ht).png")
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "$path|$($win.Title)|$($win.W)x$($win.Ht)"
}
