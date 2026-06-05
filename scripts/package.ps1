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
$xpiPath = Join-Path $dist "zotero-management-bridge-$safeVersion.xpi"

if (Test-Path $xpiPath) { Remove-Item -LiteralPath $xpiPath -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($xpiPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $rootPath = (Resolve-Path -LiteralPath $pluginRoot).Path.TrimEnd('\', '/')
  $rootPrefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
  Get-ChildItem -LiteralPath $pluginRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($rootPrefix.Length).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip,
      $_.FullName,
      $relative,
      [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
}
finally {
  $zip.Dispose()
}

Write-Output $xpiPath
