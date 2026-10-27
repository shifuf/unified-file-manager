#Requires -Version 5.1
<#
.SYNOPSIS
  Local development stack for Windows (portable MariaDB + API + Web dev server).

.DESCRIPTION
  Uses the portable MariaDB unpacked under .runtime/ (no Windows service, no admin
  rights) so the app can run locally without Docker. Ports follow .env:
  MYSQL_PORT=3307, APP_PORT=3000, VITE_WEB_PORT=5174.

.EXAMPLE
  powershell -File scripts/local-dev.ps1 start
  powershell -File scripts/local-dev.ps1 status
  powershell -File scripts/local-dev.ps1 stop
#>
[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'start'
)

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root '.runtime'
$mysqld = Get-ChildItem -Path $runtime -Filter 'mysqld.exe' -Recurse -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName

function Test-Port([int]$Port) {
  return (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded
}

function Get-EnvValue([string]$Name, [string]$Fallback) {
  $line = Select-String -Path (Join-Path $root '.env') -Pattern "^$Name=" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $line) { return $Fallback }
  return ($line.Line -split '=', 2)[1].Trim()
}

$mysqlPort = [int](Get-EnvValue 'MYSQL_PORT' '3307')
$apiPort = [int](Get-EnvValue 'APP_PORT' '3000')
$webPort = [int](Get-EnvValue 'VITE_WEB_PORT' '5174')

function Start-Database {
  if (-not $mysqld) {
    Write-Warning "未找到便携 MariaDB（$runtime）。请解压 MariaDB winx64 包到 .runtime/，或自行启动 MySQL 后设置 .env 的 MYSQL_*。"
    return
  }
  if (Test-Port $mysqlPort) {
    Write-Host "[跳过] MySQL 已在 $mysqlPort 端口运行"
    return
  }

  $dataDir = Join-Path $runtime 'mysql-data'
  $tmpDir = Join-Path $runtime 'mysql-tmp'
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  Start-Process -FilePath $mysqld `
    -ArgumentList @("--datadir=$dataDir", "--tmpdir=$tmpDir", "--port=$mysqlPort", '--bind-address=127.0.0.1', '--console', '--skip-name-resolve') `
    -WindowStyle Hidden
  Start-Sleep -Seconds 8
  Write-Host "[启动] MySQL $mysqlPort -> $(Test-Port $mysqlPort)"
}

function Start-Api {
  if (Test-Port $apiPort) {
    Write-Host "[跳过] API 已在 $apiPort 端口运行"
    return
  }
  Start-Process -FilePath 'node.exe' `
    -ArgumentList @('--enable-source-maps', (Join-Path $root 'apps/api/dist/main.js')) `
    -WorkingDirectory (Join-Path $root 'apps/api') -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime 'api.out.log') `
    -RedirectStandardError (Join-Path $runtime 'api.err.log')
  Start-Sleep -Seconds 15
  Write-Host "[启动] API $apiPort -> $(Test-Port $apiPort)（日志 .runtime/api.out.log）"
}

function Start-Web {
  if (Test-Port $webPort) {
    Write-Host "[跳过] Web 已在 $webPort 端口运行"
    return
  }
  Start-Process -FilePath 'npm.cmd' -ArgumentList @('--workspace', 'apps/web', 'run', 'dev') `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime 'web.out.log') `
    -RedirectStandardError (Join-Path $runtime 'web.err.log')
  Start-Sleep -Seconds 12
  Write-Host "[启动] Web $webPort -> $(Test-Port $webPort)（日志 .runtime/web.out.log）"
}

function Stop-LocalStack {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'apps[\\/]api[\\/]dist[\\/]main|vite' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "[停止] PID $($_.ProcessId)" }
  Get-CimInstance Win32_Process -Filter "Name = 'npm.cmd' or Name = 'cmd.exe'" |
    Where-Object { $_.CommandLine -match 'apps/web run dev|apps/api run start' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "[停止] PID $($_.ProcessId)" }
  if ($mysqld) {
    Get-CimInstance Win32_Process -Filter "Name = 'mysqld.exe'" |
      Where-Object { $_.CommandLine -match 'mysql-data' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "[停止] MySQL PID $($_.ProcessId)" }
  }
}

function Show-Status {
  Write-Host "MySQL($mysqlPort): $(Test-Port $mysqlPort)"
  Write-Host "API($apiPort):    $(Test-Port $apiPort)"
  Write-Host "Web($webPort):    $(Test-Port $webPort)"
}

switch ($Action) {
  'start' { Start-Database; Start-Api; Start-Web; Show-Status }
  'stop' { Stop-LocalStack }
  'status' { Show-Status }
}
