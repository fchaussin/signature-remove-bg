#!/usr/bin/env bash
# install.sh — one-shot installer for Signature Remove Background
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/fchaussin/signature-remove-bg/main/install.sh | bash
#   # or, after cloning the repo:
#   ./install.sh
#
# What it does:
#   1. Verifies Docker is installed and running
#   2. Pulls fchaussin/signature-remove-bg:latest
#   3. Stops/removes any prior 'signature-remove-bg' container (idempotent)
#   4. Starts a new container with port 8000 published and --restart unless-stopped
#   5. Waits up to 30 s for /health to return 200
#   6. Opens http://localhost:8000 in your default browser
#
# Override the host port:  PORT=9000 ./install.sh
# Override the image tag:  TAG=0.3.9 ./install.sh

set -euo pipefail

IMAGE_REPO="fchaussin/signature-remove-bg"
TAG="${TAG:-latest}"
IMAGE="${IMAGE_REPO}:${TAG}"
NAME="signature-remove-bg"
PORT="${PORT:-8000}"
HEALTH_TIMEOUT=30

if [ -t 1 ]; then
    BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
    BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

info()  { printf "%s%s%s\n" "$BOLD" "$*" "$RESET"; }
ok()    { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$*"; }
warn()  { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$*"; }
fail()  { printf "%s✗%s %s\n" "$RED" "$RESET" "$*" >&2; exit 1; }

# 1. Docker available?
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Get Docker Desktop: https://www.docker.com/products/docker-desktop/"
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop and re-run this script."
ok "Docker is running"

# 2. Pull image
info "Pulling $IMAGE ..."
docker pull "$IMAGE" >/dev/null
ok "Image pulled"

# 3. Idempotent cleanup (before the port check so freeing our own port doesn't cause a fallback)
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    warn "Removing existing container '$NAME'"
    docker rm -f "$NAME" >/dev/null
fi

# 3b. Pick a free host port if the requested one is already in use by another process.
#     Uses bash's /dev/tcp — built-in, no external tool required.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if port_in_use "$PORT"; then
    REQUESTED_PORT="$PORT"
    warn "Host port $REQUESTED_PORT is already in use by another process"
    NEW_PORT=""
    for i in $(seq 1 100); do
        try_port=$((REQUESTED_PORT + i))
        if ! port_in_use "$try_port"; then
            NEW_PORT="$try_port"
            break
        fi
    done
    [ -n "$NEW_PORT" ] || fail "No free port found in $REQUESTED_PORT..$((REQUESTED_PORT + 100)). Stop the conflicting service or set PORT=<other> manually."
    warn "Falling back to host port $NEW_PORT"
    PORT="$NEW_PORT"
fi

# 4. Run with the port correctly published
info "Starting container on port $PORT ..."
docker run -d \
    --name "$NAME" \
    -p "${PORT}:8000" \
    --restart unless-stopped \
    "$IMAGE" >/dev/null
ok "Container started (host port $PORT -> container port 8000)"

# 5. Wait for /health
info "Waiting for service to be ready ..."
ready=0
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
    if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
        ready=1
        break
    fi
    sleep 1
done
[ "$ready" -eq 1 ] || fail "Service did not become ready within ${HEALTH_TIMEOUT}s. Check 'docker logs $NAME'"
ok "Service is ready"

# 6. Open browser
URL="http://localhost:${PORT}"
echo
info "→ Open $URL"
echo

if   command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open     >/dev/null 2>&1; then open     "$URL" >/dev/null 2>&1 &
elif command -v start    >/dev/null 2>&1; then start    "$URL" >/dev/null 2>&1 &
fi

ok "Done. The container is now visible in Docker Desktop (Containers tab) with auto-restart on reboot."
