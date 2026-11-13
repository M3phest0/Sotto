param([int]$X, [int]$Y)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CU {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
}
"@
$ok = [CU]::SetProcessDpiAwarenessContext([IntPtr](-4))
$set = [CU]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 150
$p = New-Object CU+P
[CU]::GetCursorPos([ref]$p) | Out-Null
Write-Output ("awarenessSet={0} set={1} cursor={2},{3}" -f $ok, $set, $p.X, $p.Y)
