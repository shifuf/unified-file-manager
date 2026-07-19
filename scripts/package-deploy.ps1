#Requires -Version 5.1
<#
.SYNOPSIS
  Build a clean deploy folder (no node_modules/dist/data). You zip it yourself.

.PARAMETER OutputRoot
  Output root. Default: <repo>/deploy-package

.PARAMETER SkipBuild
  Skip local npm build validation.

.PARAMETER IncludeBuiltDist
  Also copy local apps/*/dist if present.

.EXAMPLE
  powershell -File scripts/package-deploy.ps1
  powershell -File scripts/package-deploy.ps1 -SkipBuild
#>

[CmdletBinding()]
param(
  [string]$OutputRoot = "",
  [switch]$SkipBuild,
  [switch]$IncludeBuiltDist
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Ensure-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Copy-FileSafe([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) {
    Write-Warning "skip missing file: $Source"
    return
  }
  $destDir = Split-Path -Parent $Destination
  Ensure-Dir $destDir
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-TreeFiltered {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$DestDir,
    [string[]]$ExcludeDirNames = @(),
    [string[]]$ExcludeFilePatterns = @()
  )

  if (-not (Test-Path -LiteralPath $SourceDir)) {
    Write-Warning "skip missing dir: $SourceDir"
    return
  }

  Ensure-Dir $DestDir
  $excludeDirSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $ExcludeDirNames) {
    [void]$excludeDirSet.Add($name)
  }

  Get-ChildItem -LiteralPath $SourceDir -Force | ForEach-Object {
    $name = $_.Name
    if ($_.PSIsContainer) {
      if ($excludeDirSet.Contains($name)) {
        return
      }
      $childDest = Join-Path $DestDir $name
      Copy-TreeFiltered -SourceDir $_.FullName -DestDir $childDest -ExcludeDirNames $ExcludeDirNames -ExcludeFilePatterns $ExcludeFilePatterns
      return
    }

    foreach ($pattern in $ExcludeFilePatterns) {
      if ($name -like $pattern) {
        return
      }
    }

    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $DestDir $name) -Force
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $OutputRoot) {
  $OutputRoot = Join-Path $repoRoot "deploy-package"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$packageName = "ufm-deploy-$stamp"
$packageDir = Join-Path $OutputRoot $packageName

Write-Step "repo: $repoRoot"
Write-Step "out : $packageDir"

if (Test-Path -LiteralPath $packageDir) {
  throw "output already exists: $packageDir"
}
Ensure-Dir $packageDir

if (-not $SkipBuild) {
  Write-Step "local build (api + web)"
  Push-Location $repoRoot
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) {
      throw "npm run build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Step "skip local build (-SkipBuild)"
}

Write-Step "copy root docker/config files"
$rootFiles = @(
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore",
  ".env.example",
  "README.md",
  "LICENSE"
)
foreach ($file in $rootFiles) {
  Copy-FileSafe (Join-Path $repoRoot $file) (Join-Path $packageDir $file)
}

Write-Step "copy apps/api"
$apiSrc = Join-Path $repoRoot "apps\api"
$apiDst = Join-Path $packageDir "apps\api"
Ensure-Dir $apiDst

Copy-FileSafe (Join-Path $apiSrc "package.json") (Join-Path $apiDst "package.json")
Copy-FileSafe (Join-Path $apiSrc "tsconfig.json") (Join-Path $apiDst "tsconfig.json")
Copy-FileSafe (Join-Path $apiSrc "tsconfig.build.json") (Join-Path $apiDst "tsconfig.build.json")
Copy-FileSafe (Join-Path $apiSrc "nest-cli.json") (Join-Path $apiDst "nest-cli.json")
Copy-FileSafe (Join-Path $apiSrc "docker-entrypoint.sh") (Join-Path $apiDst "docker-entrypoint.sh")

Copy-TreeFiltered -SourceDir (Join-Path $apiSrc "src") -DestDir (Join-Path $apiDst "src") -ExcludeDirNames @("node_modules", "dist")
Copy-TreeFiltered -SourceDir (Join-Path $apiSrc "prisma") -DestDir (Join-Path $apiDst "prisma") -ExcludeDirNames @("node_modules")
if (Test-Path -LiteralPath (Join-Path $apiSrc "scripts")) {
  Copy-TreeFiltered -SourceDir (Join-Path $apiSrc "scripts") -DestDir (Join-Path $apiDst "scripts") -ExcludeDirNames @("node_modules")
}
if ($IncludeBuiltDist -and (Test-Path -LiteralPath (Join-Path $apiSrc "dist"))) {
  Write-Step "include apps/api/dist"
  Copy-TreeFiltered -SourceDir (Join-Path $apiSrc "dist") -DestDir (Join-Path $apiDst "dist")
}

Write-Step "copy apps/web"
$webSrc = Join-Path $repoRoot "apps\web"
$webDst = Join-Path $packageDir "apps\web"
Ensure-Dir $webDst

Copy-FileSafe (Join-Path $webSrc "package.json") (Join-Path $webDst "package.json")
Copy-FileSafe (Join-Path $webSrc "tsconfig.json") (Join-Path $webDst "tsconfig.json")
Copy-FileSafe (Join-Path $webSrc "tsconfig.app.json") (Join-Path $webDst "tsconfig.app.json")
Copy-FileSafe (Join-Path $webSrc "tsconfig.node.json") (Join-Path $webDst "tsconfig.node.json")
Copy-FileSafe (Join-Path $webSrc "vite.config.ts") (Join-Path $webDst "vite.config.ts")
Copy-FileSafe (Join-Path $webSrc "index.html") (Join-Path $webDst "index.html")
  Copy-FileSafe (Join-Path $webSrc "docker-entrypoint.sh") (Join-Path $webDst "docker-entrypoint.sh")
  Copy-TreeFiltered -SourceDir (Join-Path $webSrc "src") -DestDir (Join-Path $webDst "src") -ExcludeDirNames @("node_modules", "dist")
if (Test-Path -LiteralPath (Join-Path $webSrc "public")) {
  Copy-TreeFiltered -SourceDir (Join-Path $webSrc "public") -DestDir (Join-Path $webDst "public")
}
if ($IncludeBuiltDist -and (Test-Path -LiteralPath (Join-Path $webSrc "dist"))) {
  Write-Step "include apps/web/dist"
  Copy-TreeFiltered -SourceDir (Join-Path $webSrc "dist") -DestDir (Join-Path $webDst "dist")
}

Write-Step "copy packages/sdk-js"
$sdkSrc = Join-Path $repoRoot "packages\sdk-js"
$sdkDst = Join-Path $packageDir "packages\sdk-js"
if (Test-Path -LiteralPath $sdkSrc) {
  Ensure-Dir $sdkDst
  Copy-FileSafe (Join-Path $sdkSrc "package.json") (Join-Path $sdkDst "package.json")
  Copy-FileSafe (Join-Path $sdkSrc "tsconfig.json") (Join-Path $sdkDst "tsconfig.json")
  if (Test-Path -LiteralPath (Join-Path $sdkSrc "src")) {
    Copy-TreeFiltered -SourceDir (Join-Path $sdkSrc "src") -DestDir (Join-Path $sdkDst "src")
  }
}

Write-Step "copy infra"
$infraSrc = Join-Path $repoRoot "infra"
if (Test-Path -LiteralPath $infraSrc) {
  Copy-TreeFiltered -SourceDir $infraSrc -DestDir (Join-Path $packageDir "infra") -ExcludeDirNames @("node_modules")
}

Write-Step "copy helper scripts"
$scriptsDst = Join-Path $packageDir "scripts"
Ensure-Dir $scriptsDst
Copy-FileSafe (Join-Path $repoRoot "scripts\generate-crypto-key.ps1") (Join-Path $scriptsDst "generate-crypto-key.ps1")

Write-Step "create data placeholders"
  # Named volumes hold runtime data; only keep empty data/ placeholder
  Ensure-Dir (Join-Path $packageDir "data")
  Set-Content -LiteralPath (Join-Path $packageDir "data\.gitkeep") -Value "" -Encoding ascii

Write-Step "write DEPLOY.md"
$deployTemplate = Join-Path $repoRoot "scripts\deploy-package-DEPLOY.md"
$deployOut = Join-Path $packageDir "DEPLOY.md"
$nl = [Environment]::NewLine
$header = "# UFM clean deploy package$nl$nl" + "generatedAt: $stamp$nl" + "packageName: $packageName$nl$nl"
if (Test-Path -LiteralPath $deployTemplate) {
  $body = Get-Content -LiteralPath $deployTemplate -Raw -Encoding UTF8
  if ($body -match '(?s)^#[^\r\n]*\r?\n(.*)$') {
    $body = $Matches[1].TrimStart()
  }
  Set-Content -LiteralPath $deployOut -Value ($header + $body) -Encoding UTF8
} else {
  Set-Content -LiteralPath $deployOut -Value ($header + "See README and .env.example.$nl") -Encoding UTF8
}

Write-Step "write package-manifest.json"
$manifest = [ordered]@{
  packageName = $packageName
  generatedAt = (Get-Date).ToString("o")
  repoRoot = $repoRoot
  skipBuild = [bool]$SkipBuild
  includeBuiltDist = [bool]$IncludeBuiltDist
  notes = "Clean deploy folder for docker compose. Zip this directory yourself."
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $packageDir "package-manifest.json") -Encoding UTF8

Write-Step "size summary"
$bytes = (Get-ChildItem -LiteralPath $packageDir -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
$sizeMb = [math]::Round(($bytes / 1MB), 2)

Write-Host ""
Write-Host "DONE" -ForegroundColor Green
Write-Host "dir : $packageDir"
Write-Host "size: $sizeMb MB"
Write-Host ""
Write-Host "Zip it yourself, e.g.:" -ForegroundColor Yellow
Write-Host "  Compress-Archive -Path `"$packageDir\*`" -DestinationPath `"$OutputRoot\$packageName.zip`""
Write-Host ""
