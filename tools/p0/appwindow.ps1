param(
  [int]$X = 250,
  [int]$Y = 50,
  [int]$W = 380,
  [int]$H = 300
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'P0 Normal Window'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.ClientSize = New-Object System.Drawing.Size($W, $H)
$form.BackColor = [System.Drawing.Color]::FromArgb(240, 240, 240)
$label = New-Object System.Windows.Forms.Label
$label.Text = 'P0 normal window. Covers the widget when it overlaps.'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(16, 16)
$form.Controls.Add($label)
[void]$form.ShowDialog()
