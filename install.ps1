# install.ps1 — one-shot installer for Signature Remove Background (Windows)
#
# Usage:
#   iwr -useb https://raw.githubusercontent.com/fchaussin/signature-remove-bg/main/install.ps1 | iex
#   # or, after cloning the repo:
#   .\install.ps1
#
# What it does:
#   1. Verifies Docker is installed and running
#   2. Pulls fchaussin/signature-remove-bg:latest
#   3. Stops/removes any prior 'signature-remove-bg' container (idempotent)
#   4. Starts a new container with port 8000 published and --restart unless-stopped
#   5. Waits up to 30 s for /health to return 200
#   6. Opens http://localhost:8000 in your default browser
#
# Override the host port:  $env:PORT = "9000"; iwr -useb ... | iex
# Override the image tag:  $env:TAG  = "0.3.9";  iwr -useb ... | iex

$ErrorActionPreference = "Stop"

$ImageRepo     = "fchaussin/signature-remove-bg"
$Tag           = if ($env:TAG)  { $env:TAG }  else { "latest" }
$Image         = "${ImageRepo}:${Tag}"
$Name          = "signature-remove-bg"
$Port          = if ($env:PORT) { [int]$env:PORT } else { 8000 }
$HealthTimeout = 30

function Write-Info($m) { Write-Host $m -ForegroundColor White }
function Write-Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[!]  $m" -ForegroundColor Yellow }
function Write-Fail($m) { Write-Host "[X]  $m" -ForegroundColor Red; exit 1 }

# 1. Docker available?
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail "Docker is not installed. Get Docker Desktop: https://www.docker.com/products/docker-desktop/"
}
try { docker info | Out-Null } catch {
    Write-Fail "Docker is installed but not running. Start Docker Desktop and re-run this script."
}
Write-Ok "Docker is running"

# 2. Pull image
Write-Info "Pulling $Image ..."
docker pull $Image | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "docker pull failed" }
Write-Ok "Image pulled"

# 3. Idempotent cleanup
$existing = docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $Name }
if ($existing) {
    Write-Warn "Removing existing container '$Name'"
    docker rm -f $Name | Out-Null
}

# 4. Run with the port correctly published
Write-Info "Starting container on port $Port ..."
docker run -d --name $Name -p "${Port}:8000" --restart unless-stopped $Image | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "docker run failed" }
Write-Ok "Container started"

# 5. Wait for /health
Write-Info "Waiting for service to be ready ..."
$ready = $false
for ($i = 1; $i -le $HealthTimeout; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        # not ready yet
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) { Write-Fail "Service did not become ready within $HealthTimeout s. Check 'docker logs $Name'" }
Write-Ok "Service is ready"

# 6. Open browser
$Url = "http://localhost:$Port"
Write-Host ""
Write-Info "-> Open $Url"
Write-Host ""

Start-Process $Url

Write-Ok "Done. The container is now visible in Docker Desktop (Containers tab) with auto-restart on reboot."
