param([int]$X, [int]$Y, [int]$Notches = 5)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SC {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
}
"@
[SC]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[SC]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 150
for ($i = 0; $i -lt [Math]::Abs($Notches); $i++) {
  if ($Notches -gt 0) {
    [SC]::mouse_event(0x0800, 0, 0, 0xFFFFFF88, [IntPtr]::Zero)
  } else {
    [SC]::mouse_event(0x0800, 0, 0, 120, [IntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 60
}
Write-Output "scrolled $Notches"
