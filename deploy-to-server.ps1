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
$PasswordlessKey = Join-Path $HOME ".ssh\id_ed25519_nopwd"
$PasswordlessPub = "$PasswordlessKey.pub"
$SshArgs = @()

function Write-Utf8NoBomFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Convert-ToLf {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path $Path)) {
        return
    }

    $content = [System.IO.File]::ReadAllText($Path)
    $normalized = $content.TrimStart([char]0xFEFF) -replace "`r`n", "`n"
    if ($normalized -ne $content) {
        Write-Utf8NoBomFile -Path $Path -Content $normalized
    }
}

function Invoke-SshCommand {
    param([Parameter(Mandatory = $true)][string]$Command)
    & ssh @SshArgs $SERVER $Command
    if ($LASTEXITCODE -ne 0) {
        throw "SSH command failed: $Command"
    }
}

function Invoke-ScpUpload {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    & scp @SshArgs $Source "${SERVER}:$Destination"
    if ($LASTEXITCODE -ne 0) {
        throw "SCP upload failed: $Source -> $Destination"
    }
}

function Test-KeyAuthentication {
    if (-not ((Test-Path $PasswordlessKey) -and (Test-Path $PasswordlessPub))) {
        return $false
    }

    & ssh -i $PasswordlessKey -o BatchMode=yes -o StrictHostKeyChecking=accept-new $SERVER "exit 0" 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Initialize-PasswordlessSsh {
    if (-not (Test-Path $PasswordlessKey)) {
        throw "Missing SSH key: $PasswordlessKey"
    }

    if (-not (Test-Path $PasswordlessPub)) {
        throw "Missing SSH public key: $PasswordlessPub"
    }

    if (Test-KeyAuthentication) {
        Write-Host "   Passwordless SSH key already active." -ForegroundColor Green
        return
    }

    Write-Host "   Installing passwordless SSH key on server (one-time prompt may appear)..." -ForegroundColor Yellow
    $pubKey = [System.IO.File]::ReadAllText($PasswordlessPub).Trim()
    $escapedPubKey = $pubKey.Replace("'", "'\''")
    $bootstrapCommand = "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$escapedPubKey' ~/.ssh/authorized_keys || printf '%s\n' '$escapedPubKey' >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys"
    & ssh -o StrictHostKeyChecking=accept-new $SERVER $bootstrapCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Could not install passwordless SSH key on server."
    }

    if (-not (Test-KeyAuthentication)) {
        throw "Passwordless SSH test failed after installing the key."
    }

    Write-Host "   Passwordless SSH configured." -ForegroundColor Green
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   ABA GmbH – Deploy to SSH Server                   ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

Convert-ToLf -Path (Join-Path $LOCAL "remote-setup.sh")
Convert-ToLf -Path (Join-Path $LOCAL "deploy.sh")
Convert-ToLf -Path (Join-Path $LOCAL "push-to-ssh.sh")

Initialize-PasswordlessSsh
$SshArgs = @("-i", $PasswordlessKey, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new")

# ── Step 1: Create archive ────────────────────────────────────────────────────
Write-Host "[1/5] Creating deployment archive..." -ForegroundColor Yellow
$zip = Join-Path $LOCAL "aba-deploy.zip"
$entries = Get-ChildItem -Path $LOCAL -Force | Where-Object {
    $_.Name -notin @(
        '.git',
        'node_modules',
        'contact-submissions.ndjson',
        'agent_logs.ndjson',
        'aba-deploy.zip',
        'aba-debug.zip',
        '.mypy_cache',
        '__pycache__'
    )
} | Select-Object -ExpandProperty Name

Push-Location $LOCAL
try {
    Compress-Archive -Path $entries -DestinationPath $zip -Force
}
finally {
    Pop-Location
}
$sizeMB = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "   Archive created: aba-deploy.zip ($sizeMB MB)" -ForegroundColor Green

# ── Step 2: Create remote directory ──────────────────────────────────────────
Write-Host "[2/5] Creating remote directory..." -ForegroundColor Yellow
Invoke-SshCommand "mkdir -p $REMOTE"
Write-Host "   Directory ready: $REMOTE" -ForegroundColor Green

# ── Step 3: Upload archive ────────────────────────────────────────────────────
Write-Host "[3/5] Uploading files..." -ForegroundColor Yellow
Invoke-ScpUpload -Source $zip -Destination "$REMOTE/aba-deploy.zip"

# ── Step 4: Upload .env if exists ─────────────────────────────────────────────
$envPath = Join-Path $LOCAL ".env"
if (Test-Path $envPath) {
    Write-Host "[4/5] Uploading .env..." -ForegroundColor Yellow
    Invoke-ScpUpload -Source $envPath -Destination "$REMOTE/.env"
    Write-Host "   .env uploaded." -ForegroundColor Green
}
else {
    Write-Host "[4/5] No local .env found – make sure .env exists on server." -ForegroundColor Magenta
}

# ── Step 5: Remote extract + setup ───────────────────────────────────────────
Write-Host "[5/5] Extracting + running remote-setup.sh..." -ForegroundColor Yellow

# Write remote commands to a temp file with LF endings (no CRLF → bash errors)
$tmpScript = [System.IO.Path]::GetTempFileName() + ".sh"
$lines = @(
    "set -e",
    "cd $REMOTE",
    "command -v unzip >/dev/null 2>&1 || apt-get install -y unzip -q",
    "find . -mindepth 1 -maxdepth 1 ! -name '.env' ! -name 'aba-deploy.zip' -exec rm -rf {} +",
    "unzip -oq aba-deploy.zip -d .",
    "rm -f aba-deploy.zip",
    "sed -i 's/\r$//' remote-setup.sh deploy.sh 2>/dev/null || true",
    "chmod +x remote-setup.sh deploy.sh 2>/dev/null || true",
    "bash remote-setup.sh"
)
Write-Utf8NoBomFile -Path $tmpScript -Content (($lines -join "`n") + "`n")

# Upload the LF script and execute it
Invoke-ScpUpload -Source $tmpScript -Destination "$REMOTE/_run.sh"
Invoke-SshCommand "bash $REMOTE/_run.sh && rm -f $REMOTE/_run.sh"
Remove-Item $tmpScript -ErrorAction SilentlyContinue

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
