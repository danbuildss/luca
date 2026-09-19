#!/usr/bin/env bash
# setup-hermes.sh — Install Hermes Agent and configure the Luca profile on the VPS.
# Run as root on Ubuntu 24.04 after setup-vps.sh has completed.
# Usage: bash scripts/setup-hermes.sh

set -euo pipefail

LUCA_DIR="${LUCA_DIR:-/opt/luca}"
HERMES_HOME="/home/luca/.hermes"
HERMES_ENV="$HERMES_HOME/.env"

echo "=== Hermes setup starting ==="

# ---------------------------------------------------------------------------
# 1. Python 3 (Hermes requires Python >= 3.10)
# ---------------------------------------------------------------------------
if ! command -v python3 &>/dev/null; then
  apt-get update -q
  apt-get install -y python3 python3-pip python3-venv
fi
PYTHON_VER=$(python3 --version | awk '{print $2}')
echo "Python: $PYTHON_VER"

# ---------------------------------------------------------------------------
# 2. Install Hermes Agent via pip
# ---------------------------------------------------------------------------
echo "Installing Hermes Agent…"
pip3 install --quiet --upgrade hermes-agent 2>/dev/null || {
  # Fallback: try from GitHub if PyPI package name differs
  pip3 install --quiet --upgrade git+https://github.com/NousResearch/hermes-agent.git 2>/dev/null || {
    echo "WARNING: Could not install hermes-agent via pip."
    echo "Please install manually: https://hermes-agent.nousresearch.com"
    echo "Then re-run this script."
    exit 1
  }
}

HERMES_CMD=$(command -v hermes 2>/dev/null || true)
if [ -z "$HERMES_CMD" ]; then
  # Try ~/.local/bin
  export PATH="$PATH:/home/luca/.local/bin:/root/.local/bin"
  HERMES_CMD=$(command -v hermes 2>/dev/null || true)
fi
echo "Hermes: ${HERMES_CMD:-not found in PATH}"

# ---------------------------------------------------------------------------
# 3. Create Hermes home directory structure under luca user
# ---------------------------------------------------------------------------
echo "Creating ~/.hermes directory structure…"
mkdir -p "$HERMES_HOME"/{logs,memories,skills,cron,luca/plugins,profiles}

# ---------------------------------------------------------------------------
# 4. Copy Luca profile files from repo
# ---------------------------------------------------------------------------
echo "Copying Luca profile files…"

# Core identity and config
cp "$LUCA_DIR/hermes/SOUL.md"     "$HERMES_HOME/SOUL.md"
cp "$LUCA_DIR/hermes/config.yaml" "$HERMES_HOME/config.yaml"
cp "$LUCA_DIR/hermes/BOOTSTRAP.md" "$HERMES_HOME/BOOTSTRAP.md"

# Luca context files (the "project" directory)
cp "$LUCA_DIR/hermes/luca/"*.md   "$HERMES_HOME/luca/"

# Python plugin
cp "$LUCA_DIR/hermes/luca/plugins/luca_core.py" "$HERMES_HOME/luca/plugins/luca_core.py"

# Skills
mkdir -p "$HERMES_HOME/skills/luca-finance"
cp "$LUCA_DIR/hermes/skills/luca-finance/SKILL.md" "$HERMES_HOME/skills/luca-finance/SKILL.md"

# Cron jobs
cp "$LUCA_DIR/hermes/cron/"*.md "$HERMES_HOME/cron/" 2>/dev/null || true

# Memory templates (only if not already initialized)
if [ ! -f "$HERMES_HOME/memories/MEMORY.md" ]; then
  cp "$LUCA_DIR/hermes/memories/MEMORY.md" "$HERMES_HOME/memories/MEMORY.md"
  cp "$LUCA_DIR/hermes/memories/USER.md"   "$HERMES_HOME/memories/USER.md"
fi

# ---------------------------------------------------------------------------
# 5. Create .env file for Hermes
# ---------------------------------------------------------------------------
if [ ! -f "$HERMES_ENV" ]; then
  echo "Creating $HERMES_ENV…"
  cat > "$HERMES_ENV" <<'EOF'
# Hermes environment — fill in all values
# NEVER commit this file to git

# LLM provider
OPENAI_API_KEY=

# Telegram gateway
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_ID=

# Luca Core API (localhost — should not change)
LUCA_API_BASE=http://127.0.0.1:3000

# The user ID in Luca's database that maps to the Telegram principal
# Run: SELECT id FROM users WHERE telegram_id = '<your telegram id>';
LUCA_USER_ID=
EOF
  chmod 600 "$HERMES_ENV"
  echo "IMPORTANT: Fill in $HERMES_ENV before starting Hermes."
else
  echo "$HERMES_ENV already exists — skipping creation."
fi

# ---------------------------------------------------------------------------
# 6. Set ownership
# ---------------------------------------------------------------------------
chown -R luca:luca "$HERMES_HOME"

# ---------------------------------------------------------------------------
# 7. systemd service for Hermes
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/luca-hermes.service <<EOF
[Unit]
Description=Luca Hermes Agent
After=network.target luca-worker.service
Requires=luca-worker.service

[Service]
Type=simple
User=luca
Group=luca
WorkingDirectory=$HERMES_HOME
EnvironmentFile=$HERMES_ENV
ExecStart=$(command -v hermes || echo /usr/local/bin/hermes) start --config $HERMES_HOME/config.yaml
Restart=on-failure
RestartSec=10
KillMode=process
TimeoutStopSec=30
StandardOutput=append:$HERMES_HOME/logs/hermes.log
StandardError=append:$HERMES_HOME/logs/hermes.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable luca-hermes.service

echo ""
echo "=== Hermes setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit $HERMES_ENV — add OPENAI_API_KEY, TELEGRAM_BOT_TOKEN,"
echo "     TELEGRAM_ALLOWED_USER_ID, and LUCA_USER_ID"
echo "  2. Stop the Telegraf bot (it shares the same bot token):"
echo "     systemctl stop luca-telegram && systemctl disable luca-telegram"
echo "  3. Start Hermes:"
echo "     systemctl start luca-hermes"
echo "  4. Watch the logs:"
echo "     tail -f $HERMES_HOME/logs/hermes.log"
echo ""
echo "To connect ChatGPT subscription instead of bare OpenAI API:"
echo "  hermes model   # then select 'GitHub Copilot' and follow the OAuth flow"
