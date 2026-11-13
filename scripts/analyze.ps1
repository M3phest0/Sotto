param([string]$Path)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Path)
Write-Output ("size {0}x{1}" -f $bmp.Width, $bmp.Height)
$y = [int]($bmp.Height * 0.75)
$last = ""
$start = 0
for ($x = 0; $x -lt $bmp.Width; $x++) {
  $c = $bmp.GetPixel($x, $y)
  $key = "{0},{1},{2}" -f $c.R, $c.G, $c.B
  if ($key -ne $last) {
    if ($last -ne "") {
      if ($x - $start -ge 8) { Write-Output ("run {0}-{1} len {2} color {3}" -f $start, ($x - 1), ($x - $start), $last) }
    }
    $last = $key
    $start = $x
  }
}
Write-Output ("run {0}-{1} len {2} color {3}" -f $start, ($bmp.Width - 1), ($bmp.Width - $start), $last)
$bmp.Dispose()
