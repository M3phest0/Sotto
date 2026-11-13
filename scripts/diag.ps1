param([int]$ProcId)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RG {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, Ri, B; }
}
"@
[RG]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Write-Output ("screen {0}x{1}" -f [RG]::GetSystemMetrics(0), [RG]::GetSystemMetrics(1))
$script:rows = New-Object System.Collections.ArrayList
$cb = [RG+EnumProc]{ param($h, $l)
  $p = 0
  [RG]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq $ProcId -and [RG]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [RG]::GetWindowTextW($h, $sb, 256) | Out-Null
    $wr = New-Object RG+RECT; [RG]::GetWindowRect($h, [ref]$wr) | Out-Null
    $cr = New-Object RG+RECT; [RG]::GetClientRect($h, [ref]$cr) | Out-Null
    $dpi = [RG]::GetDpiForWindow($h)
    $w = $wr.Ri - $wr.L; $hh = $wr.B - $wr.T
    if ($w -gt 20 -and $hh -gt 20) {
      [void]$script:rows.Add(("{0} | rect {1},{2} {3}x{4} | client {5}x{6} | dpi {7}" -f $sb.ToString(), $wr.L, $wr.T, $w, $hh, ($cr.Ri - $cr.L), ($cr.B - $cr.T), $dpi))
    }
  }
  return $true
}
[RG]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$script:rows | ForEach-Object { Write-Output $_ }
$sw = [RG]::GetSystemMetrics(0)
$sh = [RG]::GetSystemMetrics(1)
$bmp = New-Object System.Drawing.Bitmap $sw, $sh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size $sw, $sh))
$out = Join-Path $PSScriptRoot 'screen-hidpi.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("screenshot {0}x{1} -> {2}" -f $sw, $sh, $out)
