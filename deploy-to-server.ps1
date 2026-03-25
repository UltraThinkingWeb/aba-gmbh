# deploy-to-server.ps1
# Run this in an INTERACTIVE PowerShell window (not VS Code terminal).
# You will be prompted for your SSH passphrase 2-3 times total.
#
# Usage: pwsh -File deploy-to-server.ps1
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$SERVER   = "root@37.27.216.254"
$REMOTE   = "/var/www/aba-website"
$LOCAL    = $PSScriptRoot

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   ABA GmbH – Deploy to SSH Server                   ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Create archive ────────────────────────────────────────────────────
Write-Host "[1/5] Creating deployment archive..." -ForegroundColor Yellow
$zip = Join-Path $LOCAL "aba-deploy.zip"
$exclude = @("node_modules","\.git","contact-submissions","agent_logs","__pycache__","\.mypy_cache","\.pyc","aba-deploy\.zip")
$files = Get-ChildItem -Path $LOCAL -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($LOCAL.Length + 1)
    $skip = $false
    foreach ($pat in $exclude) { if ($rel -match $pat) { $skip = $true; break } }
    -not $skip
}
Compress-Archive -Path $files.FullName -DestinationPath $zip -Force
$sizeMB = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "   Archive created: aba-deploy.zip ($sizeMB MB)" -ForegroundColor Green

# ── Step 2: Create remote directory ──────────────────────────────────────────
Write-Host "[2/5] Creating remote directory (passphrase #1)..." -ForegroundColor Yellow
ssh $SERVER "mkdir -p $REMOTE"
Write-Host "   Directory ready: $REMOTE" -ForegroundColor Green

# ── Step 3: Upload archive ────────────────────────────────────────────────────
Write-Host "[3/5] Uploading files (passphrase #2)..." -ForegroundColor Yellow
scp $zip "${SERVER}:${REMOTE}/aba-deploy.zip"

# ── Step 4: Upload .env if exists ─────────────────────────────────────────────
$envPath = Join-Path $LOCAL ".env"
if (Test-Path $envPath) {
    Write-Host "[4/5] Uploading .env..." -ForegroundColor Yellow
    scp $envPath "${SERVER}:${REMOTE}/.env"
    Write-Host "   .env uploaded." -ForegroundColor Green
} else {
    Write-Host "[4/5] No local .env found – make sure .env exists on server." -ForegroundColor Magenta
}

# ── Step 5: Remote extract + setup ───────────────────────────────────────────
Write-Host "[5/5] Extracting + running remote-setup.sh (passphrase #3)..." -ForegroundColor Yellow
$remoteCommands = @"
set -e
cd $REMOTE
# Install unzip if needed
command -v unzip >/dev/null 2>&1 || apt-get install -y unzip -q

# Extract (overwrite, keep .env)
unzip -oq aba-deploy.zip -d .
rm -f aba-deploy.zip

# Run full setup
chmod +x remote-setup.sh deploy.sh push-to-ssh.sh 2>/dev/null || true
bash remote-setup.sh
"@
ssh $SERVER $remoteCommands

# ── Cleanup local zip ─────────────────────────────────────────────────────────
Remove-Item $zip -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   Deploy complete!                                   ║" -ForegroundColor Green
Write-Host "╠══════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║   Website:  http://37.27.216.254                     ║" -ForegroundColor Green
Write-Host "║   AI Chat:  POST /agent/chat  (no auth)              ║" -ForegroundColor Green
Write-Host "║   SEO:      POST /agent/seo   (x-agent-key)          ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
