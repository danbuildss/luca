-- Migration 015: allow the health alert types the code writes
--
-- src/health/detectors.ts inserts 'worker_stale', 'wallet_stale' and 'disk_pressure',
-- but alerts_type_check never listed them, so every insert failed and aborted the
-- worker's per-user cycle before alerts were delivered. Additive: only widens the list.

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK (type IN (
  'new_counterparty', 'spend_spike', 'treasury_floor',
  'round_trip', 'unknown_high', 'large_inflow', 'large_outflow',
  'unusual_gas', 'x402_anomaly', 'classifier_degradation',
  'portfolio_up', 'portfolio_down', 'pnl_positive', 'books_attention',
  'worker_stale', 'wallet_stale', 'disk_pressure'
));
