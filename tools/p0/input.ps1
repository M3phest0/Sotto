param(
  [Parameter(Mandatory=$true)][ValidateSet('click','dblclick','drag','wheel','wind','alttabshot','move','capture')][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$X2 = 0,
  [int]$Y2 = 0,
  [int]$Delta = 0,
  [string]$Out = ''
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class P0I {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][P0I]::SetProcessDPIAware()

switch ($Action) {
  'move' { [void][P0I]::SetCursorPos($X, $Y) }
  'click' {
    [void][P0I]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 120
    [P0I]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [P0I]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
  'dblclick' {
    [void][P0I]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 120
    for ($i = 0; $i -lt 2; $i++) {
      [P0I]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      [P0I]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
  }
  'alttabshot' {
    [P0I]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    [P0I]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    [P0I]::keybd_event(0x09, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 700
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    [P0I]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    Write-Output ("alttab captured to {0}" -f $Out)
  }
  'drag' {
    [void][P0I]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 150
    [P0I]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    for ($i = 1; $i -le 20; $i++) {
      $nx = [int]($X + ($X2 - $X) * $i / 20)
      $ny = [int]($Y + ($Y2 - $Y) * $i / 20)
      [void][P0I]::SetCursorPos($nx, $ny)
      Start-Sleep -Milliseconds 25
    }
    [P0I]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
  'wheel' {
    [void][P0I]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 150
    [P0I]::mouse_event(0x0800, 0, 0, $Delta, [UIntPtr]::Zero)
  }
  'wind' {
    [P0I]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [P0I]::keybd_event(0x44, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [P0I]::keybd_event(0x44, 0, 2, [UIntPtr]::Zero)
    [P0I]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
  }
  'capture' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output ("saved {0} {1}x{2}" -f $Out, $b.Width, $b.Height)
  }
}
