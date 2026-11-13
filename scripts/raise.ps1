param([int64]$Hwnd)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RW {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
[RW]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
# HWND_TOPMOST = -1, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
$ok = [RW]::SetWindowPos([IntPtr]$Hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0002 -bor 0x0001 -bor 0x0010)
Write-Output "raised=$ok"
