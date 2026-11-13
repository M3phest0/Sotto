param([int]$X, [int]$Y, [switch]$Right)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MS {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
}
"@
[MS]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[MS]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 200
if ($Right) {
  [MS]::mouse_event(8, 0, 0, 0, [IntPtr]::Zero)
  [MS]::mouse_event(16, 0, 0, 0, [IntPtr]::Zero)
} else {
  [MS]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
  [MS]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
}
Start-Sleep -Milliseconds 600
Write-Output "clicked $X,$Y"
