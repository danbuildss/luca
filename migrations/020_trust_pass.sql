-- Migration 020: comparable portfolio snapshots and alert certainty
--
-- Additive and safe to re-run. Nothing is deleted.
--
-- 1. A daily heartbeat snapshot records what its total covered: the active wallets, the
--    assets, the prices used, the oldest balance read, and whether every read and price
--    succeeded. Portfolio alerts compare two snapshots only when both are complete and
--    cover the same wallets and assets. Rows written before this migration cannot prove
--    what they covered, so they stay complete = FALSE and are never compared.
-- 2. alerts.certainty: verified (complete data), suspected (a real signal on partial
--    data) or data_issue (stale or incomplete data, no financial claim).
-- 3. New alert type 'snapshot_incomplete': balances could not be read completely for
--    hours, so no portfolio comparison could be made.

ALTER TABLE financial_heartbeat_snapshots ADD COLUMN IF NOT EXISTS complete BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE financial_heartbeat_snapshots ADD COLUMN IF NOT EXISTS wallet_ids TEXT[];
ALTER TABLE financial_heartbeat_snapshots ADD COLUMN IF NOT EXISTS assets TEXT[];
ALTER TABLE financial_heartbeat_snapshots ADD COLUMN IF NOT EXISTS prices JSONB;
ALTER TABLE financial_heartbeat_snapshots ADD COLUMN IF NOT EXISTS oldest_balance_at TIMESTAMPTZ;
ALTER TABLE financial_heartbeat_snapshots ADD COLUMN IF NOT EXISTS incomplete_reason TEXT;
ALTER TABLE financial_heartbeat_snapshots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS certainty TEXT;
DO $$ BEGIN
  ALTER TABLE alerts ADD CONSTRAINT alerts_certainty_check
    CHECK (certainty IS NULL OR certainty IN ('verified', 'suspected', 'data_issue'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK (type IN (
  'new_counterparty', 'spend_spike', 'treasury_floor',
  'round_trip', 'unknown_high', 'large_inflow', 'large_outflow',
  'unusual_gas', 'x402_anomaly', 'classifier_degradation',
  'portfolio_up', 'portfolio_down', 'pnl_positive', 'books_attention',
  'worker_stale', 'wallet_stale', 'disk_pressure', 'ledger_incomplete', 'usdc_depeg',
  'snapshot_incomplete'
));
