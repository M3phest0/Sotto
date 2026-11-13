Add-Type -AssemblyName System.Drawing

function New-SottoIcon([int]$size, [string]$out) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 512.0

  $cream = [System.Drawing.ColorTranslator]::FromHtml('#FFF9F2')
  $red = [System.Drawing.ColorTranslator]::FromHtml('#E8563F')
  $green = [System.Drawing.ColorTranslator]::FromHtml('#6FA65B')
  $greenDark = [System.Drawing.ColorTranslator]::FromHtml('#4F843F')

  # 圆角底板
  $r = 110 * $s
  $d = 2 * $r
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $cream), $path)

  $cx = 256 * $s
  $cy = 300 * $s
  $bodyR = 150 * $s

  # 番茄主体
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $red), [float]($cx - $bodyR), [float]($cy - $bodyR), [float](2 * $bodyR), [float](2 * $bodyR))

  # 顶部叶柄（一个绿色小圆点，简单可靠）
  $leafY = $cy - $bodyR * 0.92
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $green), [float]($cx - 26 * $s), [float]($leafY - 26 * $s), [float](52 * $s), [float](52 * $s))
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $greenDark), [float]($cx - 10 * $s), [float]($leafY - 10 * $s), [float](20 * $s), [float](20 * $s))

  # 高光
  $hl = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 255, 255, 255))
  $g.FillEllipse($hl, [float]($cx - $bodyR * 0.62), [float]($cy - $bodyR * 0.72), [float]($bodyR * 0.85), [float]($bodyR * 0.55))

  $g.Dispose()
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output $out
}

New-SottoIcon 512 "$PSScriptRoot/icon-512.png"
New-SottoIcon 256 "$PSScriptRoot/icon-256.png"
New-SottoIcon 128 "$PSScriptRoot/icon-128.png"
New-SottoIcon 64 "$PSScriptRoot/icon-64.png"
New-SottoIcon 48 "$PSScriptRoot/icon-48.png"
New-SottoIcon 32 "$PSScriptRoot/icon-32.png"
New-SottoIcon 16 "$PSScriptRoot/icon-16.png"
