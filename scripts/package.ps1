param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'

$pluginRoot = Join-Path $RepoRoot 'plugin'
$manifestPath = Join-Path $pluginRoot 'manifest.json'
$manifest = Get-Content -Path $manifestPath -Raw | ConvertFrom-Json
if (-not $Version) {
  $Version = $manifest.version
}

$dist = Join-Path $RepoRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$safeVersion = $Version -replace '[^A-Za-z0-9._-]', '-'
$zipPath = Join-Path $dist "zotero-management-bridge-$safeVersion.zip"
$xpiPath = Join-Path $dist "zotero-management-bridge-$safeVersion.xpi"

if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path $xpiPath) { Remove-Item -LiteralPath $xpiPath -Force }

Compress-Archive -Path (Join-Path $pluginRoot '*') -DestinationPath $zipPath -Force
Move-Item -LiteralPath $zipPath -Destination $xpiPath

Write-Output $xpiPath
