#!/usr/bin/env bash
# =============================================================================
# Luca deploy — pulls latest, builds, restarts services.
# Run as root or a user with sudo for systemctl.
# Usage: bash scripts/deploy.sh [--branch main]
# =============================================================================
set -euo pipefail

APP_DIR="/opt/luca"
BRANCH="${BRANCH:-main}"
SERVICES="luca-worker luca-api luca-telegram"

cd "$APP_DIR"

echo "==> Pulling latest ($BRANCH)"
git fetch origin
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo "==> Installing npm dependencies"
npm ci --prefer-offline

echo "==> TypeScript build"
npm run build

echo "==> Verifying .env exists"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: $APP_DIR/.env not found. Copy .env.example and fill in values."
  exit 1
fi

echo "==> Restarting services"
for svc in $SERVICES; do
  if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
    systemctl restart "$svc"
    echo "    Restarted $svc"
  else
    systemctl enable --now "$svc"
    echo "    Enabled and started $svc"
  fi
done

echo ""
echo "==> Deploy complete. Service status:"
for svc in $SERVICES; do
  systemctl is-active --quiet "$svc" && echo "  $svc  [RUNNING]" || echo "  $svc  [FAILED]"
done

echo ""
echo "  Tail logs:"
echo "    journalctl -u luca-worker -f"
echo "    journalctl -u luca-api    -f"
