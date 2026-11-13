param([int64]$Hwnd)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ES {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
}
"@
[ES]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$h = [IntPtr]$Hwnd
$style = [ES]::GetWindowLongPtr($h, -20).ToInt64()
Write-Output ("exstyle=0x{0:X} noactivate={1} toolwindow={2} appwindow={3} layered={4}" -f $style, (($style -band 0x08000000) -ne 0), (($style -band 0x80) -ne 0), (($style -band 0x40000) -ne 0), (($style -band 0x80000) -ne 0))
