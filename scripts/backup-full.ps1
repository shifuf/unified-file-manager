#Requires -Version 5.1
<#
.SYNOPSIS
  Full system backup: database + local storage + .env (secrets) + compose.
  Restorable on a new server without losing projects/files/CDN configs.

.PARAMETER OutputDir
  Backup root directory. Default: <repo>/backups

.PARAMETER SkipStorage
  Skip local storage folder (OK if everything is on cloud storage).

.PARAMETER SkipCompress
  Do not create zip archive.

.EXAMPLE
  powershell -File scripts/backup-full.ps1
#>

[CmdletBinding()]
param(
  [string]$OutputDir = "",
  [switch]$SkipStorage,
  [switch]$SkipCompress
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-EnvMap([string]$EnvPath) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $EnvPath)) {
    throw "Missing .env: $EnvPath"
  }
  Get-Content -LiteralPath $EnvPath -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim()
    if (
      ($val.StartsWith('"') -and $val.EndsWith('"')) -or
      ($val.StartsWith("'") -and $val.EndsWith("'"))
    ) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    $map[$key] = $val
  }
  return $map
}

function Parse-DatabaseUrl([string]$Url) {
  if (-not $Url) { throw "DATABASE_URL is empty" }
  $u = $Url -replace '^mysql://', 'http://'
  try {
    $uri = [Uri]$u
  } catch {
    throw "Invalid DATABASE_URL: $Url"
  }
  $userInfo = $uri.UserInfo
  $user = ""
  $pass = ""
  if ($userInfo) {
    $parts = $userInfo.Split(":", 2)
    $user = [Uri]::UnescapeDataString($parts[0])
    if ($parts.Count -gt 1) { $pass = [Uri]::UnescapeDataString($parts[1]) }
  }
  $db = $uri.AbsolutePath.TrimStart("/").Split("?")[0]
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 3306 }
  return @{
    Host = $uri.Host
    Port = $port
    User = $user
    Password = $pass
    Database = $db
  }
}

function Find-MysqlDump {
  $candidates = @(
    (Join-Path $repoRoot ".tools\mariadb-extract\MariaDB 12.3\bin\mariadb-dump.exe"),
    (Join-Path $repoRoot ".tools\mariadb-extract\MariaDB 12.3\bin\mysqldump.exe"),
    "mariadb-dump",
    "mysqldump"
  )
  foreach ($c in $candidates) {
    if ($c -match '[\\/]' -and (Test-Path -LiteralPath $c)) { return $c }
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  throw "mysqldump/mariadb-dump not found. Install MySQL client or keep .tools MariaDB."
}

function Get-DirSizeBytes([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return [int64]0 }
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return [int64]0 }
  $measured = $files | Measure-Object -Property Length -Sum
  if ($null -eq $measured -or $null -eq $measured.Sum) { return [int64]0 }
  return [int64]$measured.Sum
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $OutputDir) {
  $OutputDir = Join-Path $repoRoot "backups"
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$packageName = "ufm-full-$stamp"
$packageDir = Join-Path $OutputDir $packageName
if (Test-Path -LiteralPath $packageDir) {
  throw "Target already exists: $packageDir"
}
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null

Write-Step "repo: $repoRoot"
Write-Step "output: $packageDir"

$envPath = Join-Path $repoRoot ".env"
$envMap = Get-EnvMap $envPath
if (-not $envMap["DATABASE_URL"]) {
  $user = if ($envMap["MYSQL_USER"]) { $envMap["MYSQL_USER"] } else { "ufm" }
  $pass = if ($envMap["MYSQL_PASSWORD"]) { $envMap["MYSQL_PASSWORD"] } else { "" }
  $host = if ($envMap["MYSQL_HOST"]) { $envMap["MYSQL_HOST"] } else { "localhost" }
  $port = if ($envMap["MYSQL_PORT"]) { $envMap["MYSQL_PORT"] } else { "3306" }
  $dbName = if ($envMap["MYSQL_DATABASE"]) { $envMap["MYSQL_DATABASE"] } else { "unified_file_manager" }
  $enc = [Uri]::EscapeDataString($pass)
  $envMap["DATABASE_URL"] = "mysql://${user}:${enc}@${host}:${port}/${dbName}"
}
$db = Parse-DatabaseUrl $envMap["DATABASE_URL"]
$storageRoot = if ($envMap["LOCAL_STORAGE_ROOT"]) { $envMap["LOCAL_STORAGE_ROOT"] } else { "./storage" }
if (-not [System.IO.Path]::IsPathRooted($storageRoot)) {
  $storageRoot = Join-Path $repoRoot ($storageRoot -replace '^\./', '' -replace '^\.\\', '')
}

Write-Step "copy .env + docker-compose"
Copy-Item -LiteralPath $envPath -Destination (Join-Path $packageDir ".env") -Force
$compose = Join-Path $repoRoot "docker-compose.yml"
if (Test-Path -LiteralPath $compose) {
  Copy-Item -LiteralPath $compose -Destination (Join-Path $packageDir "docker-compose.yml") -Force
}
$envExample = Join-Path $repoRoot ".env.example"
if (Test-Path -LiteralPath $envExample) {
  Copy-Item -LiteralPath $envExample -Destination (Join-Path $packageDir ".env.example") -Force
}

Write-Step ("dump database {0}@{1}:{2}" -f $db.Database, $db.Host, $db.Port)
$dumpExe = Find-MysqlDump
$sqlPath = Join-Path $packageDir "database.sql"
$env:MYSQL_PWD = $db.Password
try {
  & $dumpExe -h $db.Host -P $db.Port -u $db.User --single-transaction --routines --triggers --events --default-character-set=utf8mb4 --result-file=$sqlPath $db.Database
  if ($LASTEXITCODE -ne 0) {
    & $dumpExe -h $db.Host -P $db.Port -u $db.User "--password=$($db.Password)" --single-transaction --routines --triggers --events --default-character-set=utf8mb4 --result-file=$sqlPath $db.Database
    if ($LASTEXITCODE -ne 0) { throw "mysqldump failed, exit=$LASTEXITCODE" }
  }
} finally {
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $sqlPath) -or (Get-Item -LiteralPath $sqlPath).Length -lt 100) {
  throw "database.sql missing or too small. Check DB connection/permissions."
}
$sqlMb = [math]::Round((Get-Item $sqlPath).Length / 1MB, 2)
Write-Host "  database.sql = $sqlMb MB"

$storageBytes = [int64]0
$storageCopied = $false
if (-not $SkipStorage) {
  Write-Step "copy local storage: $storageRoot"
  if (Test-Path -LiteralPath $storageRoot) {
    $destStorage = Join-Path $packageDir "storage"
    New-Item -ItemType Directory -Path $destStorage -Force | Out-Null
    $rc = Start-Process -FilePath "robocopy.exe" -ArgumentList @(
      $storageRoot, $destStorage, "/E", "/COPY:DAT", "/R:2", "/W:2", "/NFL", "/NDL", "/NJH", "/NJS"
    ) -Wait -PassThru -NoNewWindow
    if ($rc.ExitCode -ge 8) {
      throw "robocopy storage failed, exit=$($rc.ExitCode)"
    }
    $storageBytes = Get-DirSizeBytes $destStorage
    $storageCopied = $true
    $stMb = [math]::Round($storageBytes / 1MB, 2)
    Write-Host "  storage = $stMb MB"
  } else {
    Write-Warning "Local storage not found, skipped: $storageRoot"
  }
} else {
  Write-Step "skip storage (-SkipStorage)"
}

Write-Step "write MANIFEST + RESTORE.md"
$manifest = [ordered]@{
  formatVersion = 1
  product       = "unified-file-manager"
  createdAt     = (Get-Date).ToString("o")
  host          = $env:COMPUTERNAME
  database      = @{
    host     = $db.Host
    port     = $db.Port
    name     = $db.Database
    sqlFile  = "database.sql"
    sqlBytes = (Get-Item $sqlPath).Length
  }
  storage = @{
    copied        = $storageCopied
    sourcePath    = $storageRoot
    includedBytes = $storageBytes
    note          = "Cloud objects are NOT in this package; encrypted CDN configs are in DB; APP_CRYPTO_KEY is in .env"
  }
  env = @{
    hasCryptoKey = [bool]$envMap["APP_CRYPTO_KEY"]
    publicUrl = $envMap["PUBLIC_URL"]
  }
  critical = @(
    "Keep backup .env intact (especially APP_CRYPTO_KEY) or vault secrets cannot decrypt",
    "On new server update PUBLIC_URL / PUBLIC_FILE_ALLOWED_DOMAINS",
    "For Docker set DATABASE_URL host to mysql and LOCAL_STORAGE_ROOT=/app/storage",
    "Qiniu/Upyun objects stay on the cloud account; no need to re-upload"
  )
}
$manifestPath = Join-Path $packageDir "MANIFEST.json"
($manifest | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$restoreLines = @(
  "# Full restore guide",
  "",
  "This backup restores projects, file metadata, encrypted storage configs, system settings, users, and local files.",
  "",
  "## Package contents",
  "",
  "| Path | Purpose |",
  "|------|---------|",
  "| `.env` | **Required** (includes APP_CRYPTO_KEY) |",
  "| `database.sql` | Full MySQL dump |",
  "| `storage/` | Local objects (if any) |",
  "| `docker-compose.yml` | Compose file |",
  "| `MANIFEST.json` | Backup metadata |",
  "",
  "## Option A: Docker (production)",
  "",
  "1. Unpack backup to e.g. /opt/ufm-backup.",
  "2. Deploy app source to /opt/ufm, copy .env from backup.",
  "3. Edit .env for new host (PUBLIC_URL, DATABASE_URL with host mysql, LOCAL_STORAGE_ROOT=/app/storage).",
  "4. docker compose up -d mysql redis",
  "5. Import SQL into MySQL (docker compose exec or host mysql client).",
  "6. Copy storage/ into the volume path used by compose (e.g. data/storage).",
  "7. docker compose --profile full up -d --build",
  "",
  "## Critical keys",
  "",
  "- APP_CRYPTO_KEY must be identical to the backup, or CDN/project vault secrets will not decrypt.",
  "- Cloud files stay on Qiniu/Upyun; only DB + crypto key are required.",
  "- Change public URLs on the new host or cookies/links will break.",
  "",
  "## Not included",
  "",
  "- node_modules / build artifacts",
  "- Redis data (sessions recreated)",
  "- Meilisearch index (rebuildable)"
)
Set-Content -LiteralPath (Join-Path $packageDir "RESTORE.md") -Value $restoreLines -Encoding UTF8

$zipPath = $null
if (-not $SkipCompress) {
  Write-Step "compress zip"
  $zipPath = Join-Path $OutputDir ($packageName + ".zip")
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -Path (Join-Path $packageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
  $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
  Write-Host "  zip = $zipPath ($zipMb MB)"
}

Write-Host ""
Write-Host "Backup complete." -ForegroundColor Green
Write-Host "  dir: $packageDir"
if ($zipPath) { Write-Host "  zip: $zipPath" }
Write-Host "  Copy the zip to the new server and follow RESTORE.md."
Write-Host "  Do NOT lose APP_CRYPTO_KEY in .env."
