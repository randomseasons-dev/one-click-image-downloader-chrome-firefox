# Builds both packages into dist\:
#   dist\chrome\  + one-click-save-image-chrome-v<ver>.zip   (Brave / Chrome / Edge)
#   dist\firefox\ + one-click-save-image-firefox-v<ver>.xpi  (Firefox)
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'

$common  = 'background.js', 'content.js', 'defaults.js', 'shared.js', 'options.html', 'options.js', 'style.css',
           'icons\icon16.png', 'icons\icon32.png', 'icons\icon48.png', 'icons\icon128.png'
$targets = @{
  chrome  = @{ manifest = 'manifest.json';         extra = 'offscreen.html', 'offscreen.js', 'grant.html', 'grant.js'; ext = 'zip' }
  firefox = @{ manifest = 'firefox\manifest.json'; extra = @();                                                         ext = 'xpi' }
}

foreach ($name in 'chrome', 'firefox') {
  $t = $targets[$name]
  $out = Join-Path $dist $name
  if (Test-Path $out) { Remove-Item $out -Recurse -Force }
  New-Item -ItemType Directory -Force (Join-Path $out 'icons') | Out-Null
  foreach ($f in $common + $t.extra) { Copy-Item (Join-Path $root $f) (Join-Path $out $f) }
  Copy-Item (Join-Path $root $t.manifest) (Join-Path $out 'manifest.json')

  $ver = (Get-Content (Join-Path $out 'manifest.json') -Raw | ConvertFrom-Json).version
  $pkg = Join-Path $dist "one-click-save-image-$name-v$ver.$($t.ext)"
  if (Test-Path $pkg) { Remove-Item $pkg -Force }
  # Zip by hand so entry names use "/" (Firefox rejects the "\" that Compress-Archive writes).
  $zip = [System.IO.Compression.ZipFile]::Open($pkg, 'Create')
  try {
    foreach ($file in Get-ChildItem $out -Recurse -File) {
      $entry = $file.FullName.Substring($out.Length + 1).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry) | Out-Null
    }
  } finally { $zip.Dispose() }
  Write-Host "built $pkg"
}
