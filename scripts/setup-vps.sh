#!/usr/bin/env bash
# =============================================================================
# Luca VPS first-run setup — Ubuntu 24.04 LTS
# Run once as root after provisioning.
# Usage: bash scripts/setup-vps.sh
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/danbuildss/luca.git"
APP_DIR="/opt/luca"
APP_USER="luca"

echo "==> [1/9] System update"
apt-get update -q
apt-get upgrade -y -q

echo "==> [2/9] Install dependencies"
apt-get install -y -q \
  curl ca-certificates gnupg git nginx ufw unzip

echo "==> [3/9] Node.js 20 LTS (NodeSource)"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -q nodejs

echo "==> [4/9] PostgreSQL 16"
apt-get install -y -q postgresql-16 postgresql-client-16

# Start and enable postgres before we try to use it
systemctl enable --now postgresql

echo "==> [5/9] Create app user and directory"
id -u "$APP_USER" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> [6/9] Clone repository"
if [ -d "$APP_DIR/.git" ]; then
  echo "    Repo already cloned — skipping clone, will deploy instead"
else
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi

echo "==> [7/9] Create Postgres database"
sudo -u postgres psql -c "CREATE USER luca WITH PASSWORD 'CHANGE_ME_DB_PASSWORD';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE luca OWNER luca;" 2>/dev/null || true
sudo -u postgres psql -d luca -f "$APP_DIR/migrations/001_initial_schema.sql" 2>/dev/null || true

echo "==> [8/9] Firewall (UFW)"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> [9/9] Systemd services + nginx"
# Copy service files
cp "$APP_DIR/deploy/luca-worker.service"   /etc/systemd/system/
cp "$APP_DIR/deploy/luca-telegram.service" /etc/systemd/system/
systemctl daemon-reload

# Nginx config
ln -sf "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/luca
ln -sf /etc/nginx/sites-available/luca /etc/nginx/sites-enabled/luca
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "============================================================"
echo "  Setup complete. Next steps:"
echo ""
echo "  1. Copy .env.example to $APP_DIR/.env and fill in all values:"
echo "       cp $APP_DIR/.env.example $APP_DIR/.env"
echo "       nano $APP_DIR/.env"
echo ""
echo "  2. Run the deploy script to build and start services:"
echo "       bash $APP_DIR/scripts/deploy.sh"
echo ""
echo "  3. Check service status:"
echo "       systemctl status luca-worker luca-telegram"
echo "       journalctl -u luca-worker -f"
echo "       journalctl -u luca-telegram -f"
echo "============================================================"
