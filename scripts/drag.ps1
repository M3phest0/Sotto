param([int]$X1, [int]$Y1, [int]$X2, [int]$Y2)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DR {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
}
"@
[DR]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[DR]::SetCursorPos($X1, $Y1) | Out-Null
Start-Sleep -Milliseconds 250
[DR]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 150
$steps = 20
for ($i = 1; $i -le $steps; $i++) {
  $x = [int]($X1 + ($X2 - $X1) * $i / $steps)
  $y = [int]($Y1 + ($Y2 - $Y1) * $i / $steps)
  [DR]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 25
}
Start-Sleep -Milliseconds 150
[DR]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 1200
Write-Output "dragged $X1,$Y1 -> $X2,$Y2"
