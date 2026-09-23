#!/usr/bin/env bash
# Daily Postgres backup for Luca.
# Keeps 7 days of compressed dumps under /opt/luca/backups/.
# Run as: bash /opt/luca/scripts/backup.sh

set -euo pipefail

BACKUP_DIR="/opt/luca/backups"
TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
OUTFILE="$BACKUP_DIR/luca_$TIMESTAMP.sql.gz"
KEEP_DAYS=7

# Load DATABASE_URL from the app's .env if not already in the environment.
ENV_FILE="/opt/luca/.env"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d'=' -f2-)
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set and not found in $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting backup → $OUTFILE"
pg_dump "$DATABASE_URL" | gzip > "$OUTFILE"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup complete ($(du -sh "$OUTFILE" | cut -f1))"

# Prune old backups
find "$BACKUP_DIR" -name 'luca_*.sql.gz' -mtime +"$KEEP_DAYS" -delete
REMAINING=$(find "$BACKUP_DIR" -name 'luca_*.sql.gz' | wc -l)
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pruned old backups — $REMAINING files retained"
