# Gets the Firefox package signed by Mozilla so normal Firefox installs it with one click.
# "unlisted" = signed for your own distribution (e.g. GitHub releases), not shown on the add-on store.
# Needs your API credentials from https://addons.mozilla.org/developers/addon/api/key/
# They are typed here (or read from WEB_EXT_API_KEY / WEB_EXT_API_SECRET) and never saved.
# Every signed upload needs a higher "version" in firefox\manifest.json than the last one.
# Usage:  powershell -ExecutionPolicy Bypass -File sign-firefox.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'build.ps1')
if ($LASTEXITCODE) { throw 'build failed' }

if (-not $env:WEB_EXT_API_KEY) { $env:WEB_EXT_API_KEY = Read-Host 'JWT issuer (looks like user:12345678:123)' }
if (-not $env:WEB_EXT_API_SECRET) {
  $s = Read-Host 'JWT secret (hidden)' -AsSecureString
  $env:WEB_EXT_API_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

$out = Join-Path $root 'dist\signed'
Write-Host 'Uploading to Mozilla for signing (usually a few minutes)...'
npx --yes web-ext@8 sign --source-dir (Join-Path $root 'dist\firefox') --artifacts-dir $out --channel unlisted
if ($LASTEXITCODE) { throw 'signing failed (see the message above)' }
Get-ChildItem $out -Filter *.xpi | Sort-Object LastWriteTime | Select-Object -Last 1 |
  ForEach-Object { Write-Host "Signed: $($_.FullName)" }
