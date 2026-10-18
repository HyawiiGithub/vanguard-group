<#
  Local AHD snapshot refresher (replaces the dead GitHub Actions cron).

  Reads the API key from a file OUTSIDE the repository, fetches the live
  snapshot, and commits + pushes only when something actually changed.

  Usage:
    powershell -ExecutionPolicy Bypass -File tools\refresh-local.ps1
    powershell -ExecutionPolicy Bypass -File tools\refresh-local.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$KeyFile = "$env:USERPROFILE\.ahd\key.env",
  [string]$Repo    = "$PSScriptRoot\.."
)

$ErrorActionPreference = 'Stop'
# Resolve the repo root robustly: this script lives in <repo>/tools.
$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $Repo
if (-not (Test-Path -LiteralPath 'tools\fetch-ahd.mjs')) {
  Write-Host "cannot locate tools\fetch-ahd.mjs under $Repo" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath $KeyFile)) {
  Write-Host "Key file not found: $KeyFile" -ForegroundColor Red
  Write-Host "Create it with: AHD_API_KEY=ahd_pub_..." -ForegroundColor Yellow
  exit 1
}
$line = Get-Content -LiteralPath $KeyFile | Where-Object { $_ -match '^\s*AHD_API_KEY\s*=' } | Select-Object -First 1
if (-not $line) { Write-Host "AHD_API_KEY not found in $KeyFile" -ForegroundColor Red; exit 1 }
$env:AHD_API_KEY = ($line -split '=', 2)[1].Trim()

$before = git rev-parse HEAD
$turnBefore = $null
if (Test-Path data\live.json) {
  try { $turnBefore = (Get-Content data\live.json -Raw | ConvertFrom-Json).game.currentTurn } catch {}
}

Write-Host "[$(Get-Date -Format HH:mm:ss)] fetching AHD snapshot..." -ForegroundColor Cyan
& node tools\fetch-ahd.mjs
if ($LASTEXITCODE -ne 0) { Write-Host "fetch failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit $LASTEXITCODE }

# Intel dossiers for everything listed in data/roster.json (corporations you add yourself).
Write-Host "[$(Get-Date -Format HH:mm:ss)] fetching intel dossiers..." -ForegroundColor Cyan
& node tools\fetch-intel.mjs
if ($LASTEXITCODE -ne 0) { Write-Host "intel fetch failed (exit $LASTEXITCODE) - snapshot still valid" -ForegroundColor Yellow }

$turnAfter = $null
try { $turnAfter = (Get-Content data\live.json -Raw | ConvertFrom-Json).game.currentTurn } catch {}
Write-Host "[$(Get-Date -Format HH:mm:ss)] turn $turnBefore -> $turnAfter" -ForegroundColor Cyan

if ($DryRun) { Write-Host "dry run: not committing" -ForegroundColor Yellow; exit 0 }

git add data/live.json data/corps.json data/history.json data/intel.json data/roster.json
if ($LASTEXITCODE -ne 0) { Write-Host "git add failed" -ForegroundColor Red; exit 1 }

# Nothing changed -> do not create an empty commit.
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host "[$(Get-Date -Format HH:mm:ss)] no data change, nothing to push" -ForegroundColor DarkGray
  exit 0
}

git commit -m "chore: refresh AHD snapshot turn $turnAfter"
if ($LASTEXITCODE -ne 0) { Write-Host "commit failed" -ForegroundColor Red; exit 1 }
git push origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host "push failed - snapshot committed locally, will retry next run" -ForegroundColor Yellow
  exit 1
}
Write-Host "[$(Get-Date -Format HH:mm:ss)] pushed turn $turnAfter" -ForegroundColor Green