# One-off: render the Sublight icon to assets/icon/*.png at the sizes we
# need for cross-platform installers. Windows ICO, Linux hicolor theme,
# macOS iconset all consume subsets of these. Run this only when the icon
# design changes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outDir   = Join-Path $repoRoot 'assets\icon'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

function Render-Png([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    $scale  = $size / 64.0
    $accent = [System.Drawing.Color]::FromArgb(90, 141, 255)
    $bgCol  = [System.Drawing.Color]::FromArgb(10, 15, 28)

    $r = [int]([Math]::Round(12 * $scale))
    if ($r -lt 1) { $r = 1 }
    $d = $r * 2
    $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path2.AddArc(0, 0, $d, $d, 180, 90)
    $path2.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path2.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path2.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path2.CloseFigure()
    $bgBrush = New-Object System.Drawing.SolidBrush($bgCol)
    $g.FillPath($bgBrush, $path2)

    $strokeW = [Math]::Max(1.0, 4.0 * $scale)
    $pen     = New-Object System.Drawing.Pen($accent, $strokeW)
    $ringR   = 18.0 * $scale
    $g.DrawEllipse($pen, ($size / 2.0) - $ringR, ($size / 2.0) - $ringR, $ringR * 2.0, $ringR * 2.0)

    $dotR    = 6.0 * $scale
    $dotBrsh = New-Object System.Drawing.SolidBrush($accent)
    $g.FillEllipse($dotBrsh, ($size / 2.0) - $dotR, ($size / 2.0) - $dotR, $dotR * 2.0, $dotR * 2.0)

    $pen.Dispose(); $bgBrush.Dispose(); $dotBrsh.Dispose(); $path2.Dispose(); $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  $path"
}

foreach ($sz in @(16, 32, 48, 64, 128, 256, 512, 1024)) {
    Render-Png $sz (Join-Path $outDir ("$sz.png"))
}

Write-Host "Done."
