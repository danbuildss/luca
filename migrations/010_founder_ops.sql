-- Migration 010: Founder ops layer
-- Role-based access, user activation tracking, activity tracking, ops summary view.

-- User role enum
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('operator', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Instrumentation columns on users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role                 user_role   NOT NULL DEFAULT 'operator',
  ADD COLUMN IF NOT EXISTS activated_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_user_active_at  TIMESTAMPTZ;

-- Cross-user ops summary view (refreshed on every read — no materialization needed at beta scale)
CREATE OR REPLACE VIEW ops_daily_summary AS
SELECT
  u.id                                                           AS user_id,
  u.telegram_id::text,
  u.telegram_username AS username,
  u.role::text,
  u.created_at                                                   AS joined_at,
  u.activated_at,
  u.last_user_active_at,
  COUNT(DISTINCT w.id) FILTER (WHERE w.active)                  AS active_wallets,
  COUNT(DISTINCT w.id)                                           AS total_wallets,
  MAX(wj.last_synced_at)                                         AS last_synced_at,
  BOOL_OR(wj.status = 'error')                                   AS has_sync_error,
  COUNT(DISTINCT w.id) FILTER (WHERE wj.status = 'error')       AS error_wallet_count,
  EXTRACT(EPOCH FROM (NOW() - MAX(wj.last_synced_at))) / 3600   AS hours_since_sync,
  (SELECT COUNT(*)::int FROM normalized_events ne WHERE ne.user_id = u.id)
                                                                 AS total_events,
  (SELECT COUNT(*)::int FROM classifications c
   WHERE c.user_id = u.id AND c.label = 'unknown' AND c.superseded_at IS NULL)
                                                                 AS unknown_count,
  (SELECT sent_at FROM briefs b WHERE b.user_id = u.id ORDER BY sent_at DESC LIMIT 1)
                                                                 AS last_brief_sent_at,
  COALESCE(fh.total_balance_usdc, 0)                            AS balance_usdc,
  COALESCE(fh.unknown_count_7d, 0)                              AS unknown_count_7d,
  wh.last_ping_at                                                AS worker_last_ping,
  EXTRACT(EPOCH FROM (NOW() - wh.last_ping_at)) / 60            AS worker_minutes_stale
FROM users u
LEFT JOIN wallets w ON w.user_id = u.id
LEFT JOIN watch_jobs wj ON wj.wallet_id = w.id
LEFT JOIN financial_heartbeat_snapshots fh
       ON fh.user_id = u.id AND fh.snapshot_date = CURRENT_DATE
CROSS JOIN (SELECT last_ping_at FROM worker_heartbeat WHERE id = 1) wh
GROUP BY
  u.id, u.telegram_id, u.telegram_username, u.role, u.created_at, u.activated_at,
  u.last_user_active_at, fh.total_balance_usdc, fh.unknown_count_7d, wh.last_ping_at;
