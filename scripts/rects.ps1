param([int]$ProcId)
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class R {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, Ri, B; }
}
"@
[R]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$cb = [R+EnumProc]{ param($h, $l)
  $p = 0
  [R]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq $ProcId -and [R]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [R]::GetWindowTextW($h, $sb, 256) | Out-Null
    $wr = New-Object R+RECT; [R]::GetWindowRect($h, [ref]$wr) | Out-Null
    $cr = New-Object R+RECT; [R]::GetClientRect($h, [ref]$cr) | Out-Null
    $dpi = [R]::GetDpiForWindow($h)
    $w = $wr.Ri - $wr.L; $hh = $wr.B - $wr.T
    if ($w -gt 20 -and $hh -gt 20) {
      Write-Output ("{0} | rect {1},{2} {3}x{4} | client {5}x{6} | dpi {7}" -f $sb.ToString(), $wr.L, $wr.T, $w, $hh, ($cr.Ri - $cr.L), ($cr.B - $cr.T), $dpi)
    }
  }
  return $true
}
[R]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
