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
param(
  [switch]$Redeploy,
  [switch]$Login,
  [switch]$GateIntel
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# --- simplest path: interactive browser login, no API token needed ---
if ($Login) {
  Write-Host "opening Cloudflare login in your browser..." -ForegroundColor Cyan
  npx --yes wrangler@latest login
  Write-Host ""
  npx --yes wrangler@latest whoami
  exit $LASTEXITCODE
}

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

# Credentials can come from cf.env OR from a prior `wrangler login`.
$haveOAuth = $false
if (-not $cf.CLOUDFLARE_API_TOKEN) {
  Write-Host "no API token file; checking for an existing wrangler login..." -ForegroundColor DarkGray
  $who = npx --yes wrangler@latest whoami 2>&1 | Out-String
  $haveOAuth = ($who -match 'Account ID') -or ($who -notmatch 'not authenticated')
}
if (-not $haveOAuth) {
  Write-Host "Not authenticated with Cloudflare." -ForegroundColor Red
  Write-Host "Run this once in your own terminal - it opens a browser, no token needed:" -ForegroundColor Yellow
  Write-Host "    npx wrangler login" -ForegroundColor Yellow
  Write-Host "or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in $env:USERPROFILE\.ahd\cf.env" -ForegroundColor Yellow
  exit 1
}
if ($cf.CLOUDFLARE_API_TOKEN) {
  $env:CLOUDFLARE_API_TOKEN = $cf.CLOUDFLARE_API_TOKEN
  $env:CLOUDFLARE_ACCOUNT_ID = $cf.CLOUDFLARE_ACCOUNT_ID
  Write-Host "using API token from cf.env" -ForegroundColor DarkGray
} else {
  Write-Host "using wrangler OAuth session" -ForegroundColor DarkGray
}
if (-not $ahd.AHD_API_KEY) {
  Write-Host "AHD_API_KEY not set in $env:USERPROFILE\.ahd\key.env" -ForegroundColor Red
  exit 1
}

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

# --- optional: gate /data/intel.json behind the access codes ---
# PBKDF2 here must match tools/auth.mjs and threat.html exactly.
if ($GateIntel) {
  $authPath = Join-Path $PSScriptRoot '..\data\auth.json'
  if (-not (Test-Path -LiteralPath $authPath)) {
    Write-Host "data/auth.json not found - run: node tools/auth.mjs init" -ForegroundColor Red
    exit 1
  }
  $a = Get-Content -LiteralPath $authPath -Raw | ConvertFrom-Json
  Write-Host "sealing access hashes into the Worker..." -ForegroundColor Cyan
  $a.salt       | npx --yes wrangler@latest secret put AUTH_SALT
  if ($LASTEXITCODE -ne 0) { Write-Host "AUTH_SALT failed" -ForegroundColor Red; exit 1 }
  $a.admin.hash | npx --yes wrangler@latest secret put ADMIN_HASH
  if ($LASTEXITCODE -ne 0) { Write-Host "ADMIN_HASH failed" -ForegroundColor Red; exit 1 }
  $a.viewer.hash| npx --yes wrangler@latest secret put VIEWER_HASH
  if ($LASTEXITCODE -ne 0) { Write-Host "VIEWER_HASH failed" -ForegroundColor Red; exit 1 }
  Write-Host "intel gate armed: /data/intel.json now requires X-AHD-Code" -ForegroundColor Green
  Write-Host "NOTE: remove data/intel.json from git for the gate to mean anything," -ForegroundColor Yellow
  Write-Host "      otherwise it stays readable straight from GitHub Pages." -ForegroundColor Yellow
} else {
  Write-Host "skipping intel gate (pass -GateIntel to arm it)" -ForegroundColor DarkGray
}

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
