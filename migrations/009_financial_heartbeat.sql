-- Migration 009: Financial Heartbeat
-- Adds daily financial baseline snapshots and extends alerts.type for heartbeat + classifier_degradation

-- Fix alerts.type CHECK constraint (was missing 'classifier_degradation', add heartbeat types)
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK (type IN (
  'new_counterparty', 'spend_spike', 'treasury_floor',
  'round_trip', 'unknown_high', 'large_inflow', 'large_outflow',
  'unusual_gas', 'x402_anomaly', 'classifier_degradation',
  'portfolio_up', 'portfolio_down', 'pnl_positive', 'books_attention'
));

-- Daily financial heartbeat snapshots
-- One row per user per calendar day (enforced by unique index on date trunc)
CREATE TABLE IF NOT EXISTS financial_heartbeat_snapshots (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_date      DATE        NOT NULL,
  total_balance_usdc NUMERIC     NOT NULL DEFAULT 0,  -- sum across all wallets (ETH + USDC in USD terms)
  net_pnl_7d         NUMERIC     NOT NULL DEFAULT 0,  -- 7-day net P&L in USDC
  revenue_7d         NUMERIC     NOT NULL DEFAULT 0,
  expenses_7d        NUMERIC     NOT NULL DEFAULT 0,
  unknown_count_7d   INTEGER     NOT NULL DEFAULT 0,
  bankr_total_usd    NUMERIC,                          -- null when Bankr unavailable
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_snapshots_user_date
  ON financial_heartbeat_snapshots(user_id, snapshot_date DESC);
