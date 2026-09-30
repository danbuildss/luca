-- Migration 028: telling a new operator when their books are ready
--
-- Additive. The backfill marks every wallet that exists when it runs, so like every
-- migration it is applied once (schema_migrations).
--
-- 1. watch_jobs.ready_notified_at: when Luca told the operator this wallet's books were
--    ready. Every wallet that exists when this runs is marked now, so wallets that are
--    already tracked never get onboarding messages.
-- 2. Two message types: wallet_ready (the first read, the balance check against the
--    chain and labeling are all done) and wallet_read_failed (the first read could not
--    finish; Luca keeps retrying). Each is sent at most once per wallet (dedup_key).

ALTER TABLE watch_jobs ADD COLUMN IF NOT EXISTS ready_notified_at TIMESTAMPTZ;
UPDATE watch_jobs SET ready_notified_at = NOW() WHERE ready_notified_at IS NULL;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK (type IN (
  'new_counterparty', 'spend_spike', 'treasury_floor',
  'round_trip', 'unknown_high', 'large_inflow', 'large_outflow',
  'unusual_gas', 'x402_anomaly', 'classifier_degradation',
  'portfolio_up', 'portfolio_down', 'pnl_positive', 'books_attention',
  'worker_stale', 'wallet_stale', 'disk_pressure', 'ledger_incomplete', 'usdc_depeg',
  'snapshot_incomplete', 'wallet_ready', 'wallet_read_failed'
));
