#!/usr/bin/env bash
# =============================================================================
# Luca Hermes setup — installs Hermes Agent and configures the luca profile.
# Run as root on Ubuntu 24.04 AFTER setup-vps.sh and deploy.sh have completed
# (i.e. the Luca Core API must be running on 127.0.0.1:3000 first).
#
# Usage: bash scripts/setup-hermes.sh
#
# BEFORE running this script, have ready:
#   - BANKR_API_KEY
#   - TELEGRAM_BOT_TOKEN
#   - Your Telegram user ID (get it from @userinfobot)
#   - LUCA_USER_ID  (UUID from: SELECT id FROM users WHERE telegram_id = '<id>';)
# =============================================================================
set -euo pipefail

APP_USER="luca"
APP_HOME="/home/luca"
APP_DIR="/opt/luca"
PROFILE_NAME="luca"
PROFILE_DIR="$APP_HOME/.hermes/profiles/$PROFILE_NAME"
HERMES_BIN="$APP_HOME/.local/bin/hermes"

echo "=== [1/6] Verify prerequisites ==="

# Luca Core API must be up before Hermes is wired to it
if ! curl -sf http://127.0.0.1:3000/health | grep -q '"status":"ok"'; then
  echo "ERROR: Luca Core API is not running on 127.0.0.1:3000."
  echo "Run 'bash $APP_DIR/scripts/deploy.sh' first, then retry."
  exit 1
fi
echo "  Luca Core API: ok"

# Home dir must exist (setup-vps.sh creates it)
if [ ! -d "$APP_HOME" ]; then
  echo "ERROR: $APP_HOME does not exist. Run setup-vps.sh first."
  exit 1
fi

echo "=== [2/6] Install Hermes Agent (official installer) ==="

# Install as the luca user so it lands in /home/luca/.local/bin/hermes
if [ -f "$HERMES_BIN" ]; then
  echo "  Hermes already installed at $HERMES_BIN — skipping install"
  sudo -u "$APP_USER" "$HERMES_BIN" --version || true
else
  sudo -u "$APP_USER" -H bash -c \
    'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-browser'
  echo "  Installed: $HERMES_BIN"
fi

# Verify
if ! sudo -u "$APP_USER" "$HERMES_BIN" --version &>/dev/null; then
  echo "ERROR: hermes binary not functional at $HERMES_BIN"
  echo "Please install manually: https://hermes-agent.nousresearch.com/docs/getting-started/installation"
  exit 1
fi
echo "  Hermes version: $(sudo -u "$APP_USER" "$HERMES_BIN" --version)"

echo "=== [3/6] Create/verify Luca Hermes profile ==="

# Check if the luca profile already exists
if sudo -u "$APP_USER" "$HERMES_BIN" profile list 2>/dev/null | grep -q "^$PROFILE_NAME"; then
  echo "  Profile '$PROFILE_NAME' already exists — skipping creation"
else
  sudo -u "$APP_USER" "$HERMES_BIN" profile create "$PROFILE_NAME"
  echo "  Created profile: $PROFILE_NAME"
fi

echo "=== [4/6] Copy Luca profile files into Hermes profile ==="

# Hermes profile directory structure after profile create:
#   $APP_HOME/.hermes/profiles/luca/
#     SOUL.md, config.yaml, memory/, skills/, cron/, plugins/

mkdir -p "$PROFILE_DIR"/{memory,skills/luca-finance,cron,plugins}
chown -R "$APP_USER:$APP_USER" "$APP_HOME/.hermes"

# Identity
cp "$APP_DIR/hermes/SOUL.md"      "$PROFILE_DIR/SOUL.md"
cp "$APP_DIR/hermes/config.yaml"  "$PROFILE_DIR/config.yaml"
cp "$APP_DIR/hermes/BOOTSTRAP.md" "$PROFILE_DIR/BOOTSTRAP.md"

# Context files (project/luca)
mkdir -p "$PROFILE_DIR/context"
cp "$APP_DIR/hermes/luca/"*.md "$PROFILE_DIR/context/"

# Python plugin
cp "$APP_DIR/hermes/luca/plugins/luca_core.py" "$PROFILE_DIR/plugins/luca_core.py"

# luca-finance skill
cp "$APP_DIR/hermes/skills/luca-finance/SKILL.md" "$PROFILE_DIR/skills/luca-finance/SKILL.md"

# Cron jobs
cp "$APP_DIR/hermes/cron/"*.md "$PROFILE_DIR/cron/" 2>/dev/null || true

# Memory templates (only on first setup — never overwrite existing memory)
if [ ! -f "$PROFILE_DIR/memory/MEMORY.md" ]; then
  cp "$APP_DIR/hermes/memories/MEMORY.md" "$PROFILE_DIR/memory/MEMORY.md"
  cp "$APP_DIR/hermes/memories/USER.md"   "$PROFILE_DIR/memory/USER.md"
fi

chown -R "$APP_USER:$APP_USER" "$PROFILE_DIR"
echo "  Files copied to $PROFILE_DIR"

echo "=== [5/6] Create profile .env (secrets) ==="

PROFILE_ENV="$PROFILE_DIR/.env"

if [ -f "$PROFILE_ENV" ]; then
  echo "  $PROFILE_ENV already exists — skipping"
else
  cat > "$PROFILE_ENV" <<'ENVEOF'
# Hermes profile secrets for the 'luca' profile
# NEVER commit this file to git

# ChatGPT auth — same BANKR_API_KEY you use on your Mac
BANKR_API_KEY=

# Telegram gateway
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_ID=

# Luca Core API — do not change unless you moved the port
LUCA_API_BASE=http://127.0.0.1:3000

# The Luca database UUID for the principal
# Get it with: sudo -u postgres psql luca -c "SELECT id FROM users WHERE telegram_id = '<id>';"
LUCA_USER_ID=
ENVEOF
  chmod 600 "$PROFILE_ENV"
  chown "$APP_USER:$APP_USER" "$PROFILE_ENV"
  echo "  Created $PROFILE_ENV — YOU MUST FILL THIS IN before starting Hermes"
fi

echo "=== [6/6] Register Hermes gateway with systemd ==="

# Hermes manages its own gateway. On Linux it can install a systemd user service.
# We run this as the luca user with --user flag so it installs under luca's systemd scope.
# The gateway starts when the luca user session starts, or we enable linger.

# Enable systemd linger for luca so its user services survive logout
loginctl enable-linger "$APP_USER" 2>/dev/null || true

# Let Hermes install its own gateway service
GATEWAY_INSTALLED=false
if sudo -u "$APP_USER" "$HERMES_BIN" gateway install --profile "$PROFILE_NAME" 2>/dev/null; then
  GATEWAY_INSTALLED=true
  echo "  Hermes gateway installed as systemd user service"
else
  echo "  Note: 'hermes gateway install' not available — will use manual service fallback"
fi

# Fallback: write a system-level service if Hermes doesn't support gateway install
if [ "$GATEWAY_INSTALLED" = "false" ]; then
  cat > /etc/systemd/system/luca-hermes.service <<SVCEOF
[Unit]
Description=Luca Hermes Agent (profile: luca)
After=network.target luca-api.service luca-worker.service
Wants=luca-api.service luca-worker.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_HOME
EnvironmentFile=$PROFILE_ENV
ExecStart=$HERMES_BIN --profile $PROFILE_NAME gateway start
Restart=on-failure
RestartSec=15
KillMode=process
TimeoutStopSec=30
StandardOutput=append:$APP_HOME/.hermes/logs/luca.log
StandardError=append:$APP_HOME/.hermes/logs/luca.log

[Install]
WantedBy=multi-user.target
SVCEOF
  mkdir -p "$APP_HOME/.hermes/logs"
  chown "$APP_USER:$APP_USER" "$APP_HOME/.hermes/logs"
  systemctl daemon-reload
  systemctl enable luca-hermes.service
  echo "  Fallback systemd service written: luca-hermes.service"
fi

echo ""
echo "============================================================"
echo "  Hermes setup complete."
echo ""
echo "  REQUIRED: Fill in the profile .env before starting:"
echo "    nano $PROFILE_ENV"
echo ""
echo "  Values needed:"
echo "    BANKR_API_KEY       — same value from your Mac"
echo "    TELEGRAM_BOT_TOKEN  — from @BotFather"
echo "    TELEGRAM_ALLOWED_USER_ID — your Telegram user ID (from @userinfobot)"
echo "    LUCA_USER_ID        — UUID from the users table"
echo ""
echo "  Then:"
echo "  1. Stop the old Telegraf bot (same token — can't run both):"
echo "       systemctl stop luca-telegram && systemctl disable luca-telegram"
echo ""
echo "  2. Test Hermes interactively first:"
echo "       sudo -u luca $HERMES_BIN --profile luca"
echo "       > Who are you?"
echo "       > Check my books."
echo ""
echo "  3. If interactive test passes, start the gateway:"
if [ "$GATEWAY_INSTALLED" = "true" ]; then
echo "       sudo -u luca systemctl --user start hermes-luca"
else
echo "       systemctl start luca-hermes"
fi
echo ""
echo "  To use ChatGPT subscription instead of bare OpenAI key:"
echo "    sudo -u luca $HERMES_BIN --profile luca model"
echo "    (select 'GitHub Copilot' and follow the OAuth flow)"
echo ""
echo "  Logs:"
echo "    tail -f $APP_HOME/.hermes/logs/luca.log"
echo "============================================================"
