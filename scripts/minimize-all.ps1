param([switch]$Restore)
$shell = New-Object -ComObject Shell.Application
if ($Restore) { $shell.UndoMinimizeAll(); Write-Output "restored" }
else { $shell.MinimizeAll(); Write-Output "minimized" }
