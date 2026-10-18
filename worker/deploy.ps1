<#
  Deploy the Vanguard live-data Worker.

  Reads credentials from files OUTSIDE the repository so nothing secret is ever
  committed:

    %USERPROFILE%\.ahd\cf.env    CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...
    %USERPROFILE%\.ahd\key.env   AHD_API_KEY=ahd_pub_...

  Usage (from the worker directory):
    powershell -ExecutionPolicy Bypass -File deploy.ps1            # full first-time deploy
    powershell -ExecutionPolicy Bypass -File deploy.ps1 -Redeploy  # skip KV creation

  Creating the Cloudflare token (once, in a browser):
    dash.cloudflare.com > My Profile > API Tokens > Create Token
    Use the "Edit Cloudflare Workers" template, or a Custom token with:
      Account  > Workers Scripts     > Edit
      Account  > Workers KV Storage  > Edit
    Put the token and your Account ID into %USERPROFILE%\.ahd\cf.env
#>
[CmdletBinding()]
param([switch]$Redeploy)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Read-EnvFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return @{} }
  $out = @{}
  foreach ($l in Get-Content -LiteralPath $path) {
    if ($l -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$') { $out[$matches[1]] = $matches[2] }
  }
  return $out
}

$cf = Read-EnvFile "$env:USERPROFILE\.ahd\cf.env"
$ahd = Read-EnvFile "$env:USERPROFILE\.ahd\key.env"

if (-not $cf.CLOUDFLARE_API_TOKEN) {
  Write-Host "CLOUDFLARE_API_TOKEN not set." -ForegroundColor Red
  Write-Host "Create one at dash.cloudflare.com > My Profile > API Tokens, then write:" -ForegroundColor Yellow
  Write-Host "  CLOUDFLARE_API_TOKEN=...`n  CLOUDFLARE_ACCOUNT_ID=..." -ForegroundColor Yellow
  Write-Host "to $env:USERPROFILE\.ahd\cf.env" -ForegroundColor Yellow
  exit 1
}
if (-not $ahd.AHD_API_KEY) {
  Write-Host "AHD_API_KEY not set in $env:USERPROFILE\.ahd\key.env" -ForegroundColor Red
  exit 1
}

$env:CLOUDFLARE_API_TOKEN = $cf.CLOUDFLARE_API_TOKEN
$env:CLOUDFLARE_ACCOUNT_ID = $cf.CLOUDFLARE_ACCOUNT_ID

Write-Host "installing/using wrangler..." -ForegroundColor Cyan
npx --yes wrangler@latest --version
if ($LASTEXITCODE -ne 0) { Write-Host "wrangler unavailable" -ForegroundColor Red; exit 1 }

# --- KV namespace: create once, then write the real id into wrangler.toml ---
$toml = Join-Path $PSScriptRoot 'wrangler.toml'
if (-not $Redeploy -or ((Get-Content $toml -Raw) -match 'PASTE_YOUR_KV_NAMESPACE_ID_HERE')) {
  Write-Host "creating KV namespace AH_DATA..." -ForegroundColor Cyan
  $out = npx --yes wrangler@latest kv namespace create AH_DATA 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Write-Host $out -ForegroundColor Red; exit 1 }
  if ($out -match '"id"\s*:\s*"([0-9a-f]{32})"') {
    $id = $matches[1]
    (Get-Content $toml -Raw).Replace('PASTE_YOUR_KV_NAMESPACE_ID_HERE', $id) |
      Set-Content -LiteralPath $toml -NoNewline
    Write-Host "bound AH_DATA -> $id" -ForegroundColor Green
  } else {
    Write-Host "could not parse namespace id from:" -ForegroundColor Yellow
    Write-Host $out -ForegroundColor Yellow
    exit 1
  }
} else {
  Write-Host "reusing existing KV binding" -ForegroundColor DarkGray
}

# --- AHD key as a Worker SECRET (never in wrangler.toml or the repo) ---
Write-Host "setting AHD_API_KEY secret..." -ForegroundColor Cyan
$ahd.AHD_API_KEY | npx --yes wrangler@latest secret put AHD_API_KEY
if ($LASTEXITCODE -ne 0) { Write-Host "secret put failed" -ForegroundColor Red; exit 1 }

Write-Host "deploying..." -ForegroundColor Cyan
npx --yes wrangler@latest deploy
if ($LASTEXITCODE -ne 0) { Write-Host "deploy failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "checking /health..." -ForegroundColor Cyan
Start-Sleep -Seconds 5
try {
  $r = Invoke-RestMethod 'https://wild-night-2ce6.batuhanylz2009.workers.dev/health' -TimeoutSec 30
  $r | ConvertTo-Json -Depth 5
  Write-Host ""
  Write-Host "first dataset fetch (this triggers a live refresh):" -ForegroundColor Cyan
  $d = Invoke-RestMethod 'https://wild-night-2ce6.batuhanylz2009.workers.dev/data/live.json' -TimeoutSec 120
  Write-Host ("  turn {0} ({1})  corps {2}" -f $d.game.currentTurn, $d.game.gameDateLabel, $d.corporations.Count)
  Write-Host ("  bankrupt: " + (($d.corporations | Where-Object { $_.alive -eq $false }).Count))
  Write-Host ""
  Write-Host "DEPLOY OK" -ForegroundColor Green
} catch {
  Write-Host "health check failed: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "deploy may still have succeeded; re-run the checks manually." -ForegroundColor Yellow
}
