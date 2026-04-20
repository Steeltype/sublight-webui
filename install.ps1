# install.ps1 — Windows installer for Sublight.
# Packs the committed PNG icon set into an .ico and creates a desktop
# shortcut pointing at start-sublight.cmd. Idempotent — running it again
# refreshes the icon and shortcut in place.
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$pngDir   = Join-Path $repoRoot 'assets\icon'
$iconPath = Join-Path $repoRoot 'assets\sublight.ico'
$cmdPath  = Join-Path $repoRoot 'start-sublight.cmd'
$desktop  = [Environment]::GetFolderPath('Desktop')
$lnkPath  = Join-Path $desktop 'Sublight.lnk'

# Sizes to pack. Subset of what render-pngs.ps1 produces; these are what
# Windows actually uses across taskbar, alt-tab, desktop, and start menu.
$sizes = @(16, 32, 48, 64, 128, 256)

foreach ($sz in $sizes) {
    $p = Join-Path $pngDir "$sz.png"
    if (-not (Test-Path $p)) {
        Write-Error "Missing icon PNG: $p. Run scripts/render-pngs.ps1 to regenerate the asset set."
    }
}

if (-not (Test-Path $cmdPath)) {
    Write-Error "Missing launcher: $cmdPath. Is this a clean checkout?"
}

# ---------------------------------------------------------------------------
# Pack PNGs into a multi-resolution ICO. Format is a 6-byte ICONDIR,
# followed by one 16-byte ICONDIRENTRY per size, then concatenated image
# payloads. PNG-in-ICO is supported by Vista+ and is the modern way to
# handle large entries.
# ---------------------------------------------------------------------------

$images = @()
foreach ($sz in $sizes) {
    $images += ,([System.IO.File]::ReadAllBytes((Join-Path $pngDir "$sz.png")))
}

$icoStream = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($icoStream)
$bw.Write([uint16]0)            # reserved
$bw.Write([uint16]1)            # type = icon
$bw.Write([uint16]$sizes.Count)

$dataOffset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz    = $sizes[$i]
    $bytes = $images[$i]
    $dim   = if ($sz -ge 256) { 0 } else { $sz }   # 256 encodes as 0
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)          # palette count
    $bw.Write([byte]0)          # reserved
    $bw.Write([uint16]1)        # planes
    $bw.Write([uint16]32)       # bits per pixel
    $bw.Write([uint32]$bytes.Length)
    $bw.Write([uint32]$dataOffset)
    $dataOffset += $bytes.Length
}
foreach ($img in $images) { $bw.Write($img) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($iconPath, $icoStream.ToArray())
$bw.Dispose(); $icoStream.Dispose()
Write-Host "icon    : $iconPath"

# ---------------------------------------------------------------------------
# Create the desktop shortcut via WScript.Shell COM. Target and working
# directory both anchor to the repo so the shortcut works regardless of
# where the user's current directory is at launch.
# ---------------------------------------------------------------------------

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnkPath)
$sc.TargetPath       = $cmdPath
$sc.WorkingDirectory = $repoRoot
$sc.Description      = 'Start Sublight WebUI'
$sc.IconLocation     = "$iconPath,0"
$sc.Save()
Write-Host "shortcut: $lnkPath"
Write-Host ''
Write-Host 'Installed. Double-click the Sublight shortcut on your desktop to launch.'
