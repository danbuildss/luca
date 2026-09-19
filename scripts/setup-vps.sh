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
APP_HOME="/home/luca"

echo "==> [1/10] System update"
apt-get update -q
apt-get upgrade -y -q

echo "==> [2/10] Install dependencies"
apt-get install -y -q \
  curl ca-certificates gnupg git nginx ufw unzip pwgen

echo "==> [3/10] Node.js 20 LTS (NodeSource)"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -q nodejs

echo "==> [4/10] PostgreSQL 16"
apt-get install -y -q postgresql-16 postgresql-client-16
systemctl enable --now postgresql

echo "==> [5/10] Create app user with home directory"
# Hermes needs /home/luca — create as a normal (non-system) user with a home dir.
if id -u "$APP_USER" &>/dev/null; then
  echo "    User $APP_USER already exists"
  # Ensure home dir exists and is owned correctly
  mkdir -p "$APP_HOME"
  chown "$APP_USER:$APP_USER" "$APP_HOME"
else
  useradd --create-home --home-dir "$APP_HOME" --shell /bin/bash "$APP_USER"
  echo "    Created user $APP_USER with home $APP_HOME"
fi

mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> [6/10] Clone repository"
if [ -d "$APP_DIR/.git" ]; then
  echo "    Repo already cloned — skipping"
else
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi

echo "==> [7/10] Create Postgres database"
# Generate a strong random password for the DB user
DB_PASS=$(pwgen -s 32 1)
sudo -u postgres psql -c "CREATE USER luca WITH PASSWORD '$DB_PASS';" 2>/dev/null \
  || sudo -u postgres psql -c "ALTER USER luca WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -c "CREATE DATABASE luca OWNER luca;" 2>/dev/null || true

# Run migrations
for f in "$APP_DIR"/migrations/*.sql; do
  sudo -u postgres psql -d luca -f "$f" 2>/dev/null || true
done

# Save the password so the next step can write .env
echo "$DB_PASS" > /root/.luca_db_pass
chmod 600 /root/.luca_db_pass
echo "    DB password saved to /root/.luca_db_pass"

echo "==> [8/10] Firewall (UFW)"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> [9/10] Systemd services"
cp "$APP_DIR/deploy/luca-worker.service" /etc/systemd/system/
cp "$APP_DIR/deploy/luca-api.service"    /etc/systemd/system/
# luca-telegram.service is kept but NOT enabled — Hermes replaces it
cp "$APP_DIR/deploy/luca-telegram.service" /etc/systemd/system/ 2>/dev/null || true
systemctl daemon-reload

echo "==> [10/10] Nginx"
ln -sf "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/luca
ln -sf /etc/nginx/sites-available/luca /etc/nginx/sites-enabled/luca
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

DB_PASS=$(cat /root/.luca_db_pass)
echo ""
echo "============================================================"
echo "  Setup complete."
echo ""
echo "  DB password (save this — you'll need it in .env):"
echo "    $DB_PASS"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Create /opt/luca/.env (use .env.example as template):"
echo "       cp $APP_DIR/.env.example $APP_DIR/.env"
echo "       nano $APP_DIR/.env"
echo "     Set DATABASE_URL to:"
echo "       postgres://luca:$DB_PASS@localhost:5432/luca"
echo ""
echo "  2. Create yourself in the database (run the SQL below, then copy the UUID):"
echo "       sudo -u postgres psql luca"
echo "       INSERT INTO users (telegram_id, timezone)"
echo "         VALUES ('<your telegram id>', 'UTC')"
echo "         ON CONFLICT (telegram_id) DO UPDATE SET timezone = EXCLUDED.timezone"
echo "         RETURNING id;"
echo "     That UUID becomes LUCA_USER_ID in Hermes .env."
echo ""
echo "  3. Build and start Luca Core:"
echo "       bash $APP_DIR/scripts/deploy.sh"
echo ""
echo "  4. Verify the API is up:"
echo "       curl http://127.0.0.1:3000/health"
echo ""
echo "  5. Then run Hermes setup:"
echo "       bash $APP_DIR/scripts/setup-hermes.sh"
echo "============================================================"
