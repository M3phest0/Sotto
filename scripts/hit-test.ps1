param([int]$X, [int]$Y)
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class HT {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
[HT]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$p = New-Object HT+POINT
$p.X = $X; $p.Y = $Y
$h = [HT]::WindowFromPoint($p)
$proc = 0
[HT]::GetWindowThreadProcessId($h, [ref]$proc) | Out-Null
$cls = New-Object System.Text.StringBuilder 256
[HT]::GetClassNameW($h, $cls, 256) | Out-Null
$txt = New-Object System.Text.StringBuilder 256
[HT]::GetWindowTextW($h, $txt, 256) | Out-Null
Write-Output ("hwnd={0} pid={1} class={2} title={3}" -f $h, $proc, $cls.ToString(), $txt.ToString())
