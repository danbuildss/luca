-- Migration 019: prices read from the chain, and answers that can be traced
--
-- Additive and safe to re-run. Nothing is deleted.
--
-- 1. normalized_events.price_ref: where a transfer's USD value came from, in words
--    ("Chainlink ETH/USD at block 51733472", "your swap in 0xabc…").
--    normalized_events.price_checked_at: when the worker last tried to replace an older
--    price (CoinGecko daily, unavailable) with one read on chain.
--    price_source gains: 'chainlink', 'pool_twap', 'pool_spot', 'swap'.
-- 2. price_sources: the result of each on-chain source's check (feed description and
--    decimals, pool tokens), shown in /ops. A source that fails is not used.
-- 3. answer_traces: every answer with the question and the exact tool calls (periods,
--    filters) behind it, so a follow-up refers to the same figures.
-- 4. alerts may be of type 'usdc_depeg'.

ALTER TABLE normalized_events ADD COLUMN IF NOT EXISTS price_ref TEXT;
ALTER TABLE normalized_events ADD COLUMN IF NOT EXISTS price_checked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS price_sources (
  name       TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('ok', 'mismatch', 'error')),
  detail     TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS answer_traces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  tools      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ "name": ..., "args": {...} }]
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_answer_traces_user ON answer_traces(user_id, created_at DESC);

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK (type IN (
  'new_counterparty', 'spend_spike', 'treasury_floor',
  'round_trip', 'unknown_high', 'large_inflow', 'large_outflow',
  'unusual_gas', 'x402_anomaly', 'classifier_degradation',
  'portfolio_up', 'portfolio_down', 'pnl_positive', 'books_attention',
  'worker_stale', 'wallet_stale', 'disk_pressure', 'ledger_incomplete', 'usdc_depeg'
));
