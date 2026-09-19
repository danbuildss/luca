#!/usr/bin/env bash
# =============================================================================
# Luca Hermes setup — installs Hermes and imports/configures the luca profile.
# Run as root on Ubuntu 24.04 AFTER setup-vps.sh and deploy.sh have completed
# AND after curl http://127.0.0.1:3000/health returns {"status":"ok"}.
#
# Usage:
#   bash scripts/setup-hermes.sh /path/to/luca-hermes.tar.gz   # recommended
#   bash scripts/setup-hermes.sh                               # fresh profile fallback
#
# Export from Mac first:
#   hermes profile export default -o ~/Desktop/luca-hermes.tar.gz
#   scp ~/Desktop/luca-hermes.tar.gz root@YOUR_VPS_IP:/tmp/
# =============================================================================
set -euo pipefail

APP_USER="luca"
APP_HOME="/home/luca"
APP_DIR="/opt/luca"
PROFILE_NAME="luca"
HERMES_BIN="$APP_HOME/.local/bin/hermes"
PROFILE_ARCHIVE="${1:-}"

echo "=== [1/7] Verify prerequisites ==="

if ! curl -sf http://127.0.0.1:3000/health | grep -q '"status":"ok"'; then
  echo "ERROR: Luca Core API is not running on 127.0.0.1:3000."
  echo "Run 'bash $APP_DIR/scripts/deploy.sh' first, then retry."
  exit 1
fi
echo "  Luca Core API: ok"

if [ ! -d "$APP_HOME" ]; then
  echo "ERROR: $APP_HOME does not exist. Run setup-vps.sh first."
  exit 1
fi
echo "  Home dir: ok"

echo "=== [2/7] Install Hermes (official installer) ==="

if [ -f "$HERMES_BIN" ]; then
  echo "  Hermes already installed: $(sudo -u "$APP_USER" "$HERMES_BIN" --version 2>/dev/null || echo 'version unknown')"
else
  echo "  Installing Hermes as $APP_USER..."
  sudo -u "$APP_USER" -H bash -c \
    'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-browser'
  echo "  Installed: $HERMES_BIN"
fi

if ! sudo -u "$APP_USER" "$HERMES_BIN" --version &>/dev/null; then
  echo "ERROR: hermes binary not functional at $HERMES_BIN"
  exit 1
fi

echo "=== [3/7] Import or create Luca profile ==="

PROFILE_EXISTS=false
if sudo -u "$APP_USER" "$HERMES_BIN" profile list 2>/dev/null | grep -q "$PROFILE_NAME"; then
  PROFILE_EXISTS=true
  echo "  Profile '$PROFILE_NAME' already exists — skipping import/create"
fi

if [ "$PROFILE_EXISTS" = "false" ]; then
  if [ -n "$PROFILE_ARCHIVE" ] && [ -f "$PROFILE_ARCHIVE" ]; then
    # Import from Mac export — carries SOUL, skills, memory, config, cron
    echo "  Importing profile from: $PROFILE_ARCHIVE"
    sudo -u "$APP_USER" "$HERMES_BIN" profile import "$PROFILE_ARCHIVE" --name "$PROFILE_NAME"
    echo "  Profile imported successfully"
  else
    # Fallback: create fresh profile and copy files from repo
    echo "  No archive provided — creating fresh profile from repo files"
    sudo -u "$APP_USER" "$HERMES_BIN" profile create "$PROFILE_NAME"

    PROFILE_DIR="$APP_HOME/.hermes/profiles/$PROFILE_NAME"
    mkdir -p "$PROFILE_DIR"/{memory,skills/luca-finance,cron}

    cp "$APP_DIR/hermes/SOUL.md"      "$PROFILE_DIR/SOUL.md"
    cp "$APP_DIR/hermes/config.yaml"  "$PROFILE_DIR/config.yaml"
    cp "$APP_DIR/hermes/BOOTSTRAP.md" "$PROFILE_DIR/BOOTSTRAP.md"
    mkdir -p "$PROFILE_DIR/context"
    cp "$APP_DIR/hermes/luca/"*.md    "$PROFILE_DIR/context/"
    cp "$APP_DIR/hermes/skills/luca-finance/SKILL.md" \
       "$PROFILE_DIR/skills/luca-finance/SKILL.md"
    cp "$APP_DIR/hermes/cron/"*.md    "$PROFILE_DIR/cron/" 2>/dev/null || true

    if [ ! -f "$PROFILE_DIR/memory/MEMORY.md" ]; then
      cp "$APP_DIR/hermes/memories/MEMORY.md" "$PROFILE_DIR/memory/MEMORY.md"
      cp "$APP_DIR/hermes/memories/USER.md"   "$PROFILE_DIR/memory/USER.md"
    fi
  fi
fi

echo "=== [4/7] Install luca_core.py plugin (always update to latest) ==="

# Find where Hermes put this profile
PROFILE_DIR=$(sudo -u "$APP_USER" "$HERMES_BIN" profile show "$PROFILE_NAME" 2>/dev/null \
  | grep -i "path\|directory\|dir" | awk '{print $NF}' | head -1 || true)

# Fallback path if show command doesn't give us the path
if [ -z "$PROFILE_DIR" ] || [ ! -d "$PROFILE_DIR" ]; then
  PROFILE_DIR="$APP_HOME/.hermes/profiles/$PROFILE_NAME"
fi

mkdir -p "$PROFILE_DIR/plugins"
cp "$APP_DIR/hermes/luca/plugins/luca_core.py" "$PROFILE_DIR/plugins/luca_core.py"
chown -R "$APP_USER:$APP_USER" "$PROFILE_DIR/plugins"
echo "  Plugin installed: $PROFILE_DIR/plugins/luca_core.py"

echo "=== [5/7] Create profile .env (secrets) ==="

PROFILE_ENV="$PROFILE_DIR/.env"

if [ -f "$PROFILE_ENV" ]; then
  echo "  $PROFILE_ENV already exists — not overwriting"
  echo "  Make sure these values are set inside it:"
  echo "    BANKR_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, LUCA_USER_ID"
else
  cat > "$PROFILE_ENV" <<'ENVEOF'
# Hermes secrets for the luca profile — fill in all values
# NEVER commit this file to git

# ChatGPT auth (same BANKR_API_KEY from your Mac ~/.hermes/.env)
BANKR_API_KEY=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_ID=

# Luca Core API — do not change
LUCA_API_BASE=http://127.0.0.1:3000

# Your UUID from: sudo -u postgres psql luca -c "SELECT id FROM users WHERE telegram_id='<id>';"
LUCA_USER_ID=
ENVEOF
  chmod 600 "$PROFILE_ENV"
  chown "$APP_USER:$APP_USER" "$PROFILE_ENV"
  echo "  Created $PROFILE_ENV — fill in all values before starting"
fi

echo "=== [6/7] Enable systemd linger (keep Hermes alive after logout) ==="
loginctl enable-linger "$APP_USER" 2>/dev/null && echo "  Linger enabled for $APP_USER" || true

echo "=== [7/7] Register persistent Hermes gateway ==="

# Let Hermes install its own systemd service (official method)
GATEWAY_OK=false
if sudo -u "$APP_USER" "$HERMES_BIN" gateway install --profile "$PROFILE_NAME" 2>/dev/null; then
  GATEWAY_OK=true
  echo "  Hermes gateway service installed (official)"
else
  # Fallback: write a system-level service
  mkdir -p "$APP_HOME/.hermes/logs"
  chown "$APP_USER:$APP_USER" "$APP_HOME/.hermes/logs"

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
  systemctl daemon-reload
  systemctl enable luca-hermes.service
  echo "  Fallback systemd service written: luca-hermes.service"
fi

chown -R "$APP_USER:$APP_USER" "$APP_HOME/.hermes"

echo ""
echo "============================================================"
echo "  Hermes setup complete."
echo ""
echo "  NEXT STEPS (in order):"
echo ""
echo "  1. Fill in the profile secrets:"
echo "       nano $PROFILE_ENV"
echo "     Values: BANKR_API_KEY (from Mac .env), TELEGRAM_BOT_TOKEN,"
echo "     TELEGRAM_ALLOWED_USER_ID, LUCA_USER_ID"
echo ""
echo "  2. Connect ChatGPT subscription:"
echo "       sudo -u luca $HERMES_BIN --profile $PROFILE_NAME model"
echo "     Select: OpenAI Codex / ChatGPT — then log in with your account"
echo ""
echo "  3. Stop the old Telegram bot:"
echo "       systemctl stop luca-telegram && systemctl disable luca-telegram"
echo ""
echo "  4. Test Luca interactively BEFORE going live:"
echo "       sudo -u luca $HERMES_BIN --profile $PROFILE_NAME"
echo "       > Who are you?"
echo "       > Check my books."
echo ""
echo "  5. Start the gateway:"
if [ "$GATEWAY_OK" = "true" ]; then
echo "       sudo -u luca systemctl --user start hermes@$PROFILE_NAME"
else
echo "       systemctl start luca-hermes"
fi
echo ""
echo "  6. Reboot and verify everything comes back:"
echo "       reboot"
echo "       # After reboot, message @AskLucaBot on Telegram"
echo "============================================================"
