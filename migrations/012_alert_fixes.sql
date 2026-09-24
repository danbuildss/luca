-- Migration 012: Alert delivery failure tracking
-- Alerts that can never be delivered (Telegram 403: bot blocked / user deactivated)
-- are marked here so the worker stops retrying them every 60s.
-- src/alerts/deliver.ts filters on delivery_failed_at IS NULL — run this before deploying it.

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS delivery_failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_error     TEXT;

-- Supports the spike/floor cooldown lookup (user_id, type, created_at > NOW() - 24h)
CREATE INDEX IF NOT EXISTS idx_alerts_user_type_created
  ON alerts(user_id, type, created_at DESC);
