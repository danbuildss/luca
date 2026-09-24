-- Migration 016: raw evidence, real gas, provider ranges and the balance check
--
-- Additive and safe to re-run. Nothing is deleted.
--
-- 1. raw_transfers: every transfer exactly as a provider reported it (spam included),
--    with the integer amount. raw_receipts: every transaction a watched wallet sent,
--    with its fee (L2 execution + L1 data fee + operator fee).
-- 2. normalized_events.raw_amount / block_number: exact amounts for the balance check.
-- 3. sync_runs records the block range it covered, whether it was degraded (Blockscout
--    fallback or a failed cross-check) and how many transfers only the token logs had.
-- 4. ledger_checkpoints + reconciliation_runs: the hourly balance check.
-- 5. watch_jobs carries each wallet's ledger status.
-- 6. alerts may be of type 'ledger_incomplete'.
-- 7. Cursors rewind to each wallet's oldest stored block so the next sync re-reads
--    history into the raw tables and records past gas.

CREATE TABLE IF NOT EXISTS raw_transfers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  chain         TEXT NOT NULL DEFAULT 'base',
  tx_hash       TEXT NOT NULL,
  source_key    TEXT NOT NULL,
  block_number  BIGINT,
  block_hash    TEXT,
  category      TEXT NOT NULL,          -- external | internal | erc20 | log
  token_address TEXT,                   -- lowercase; NULL for native ETH
  raw_amount    NUMERIC(78, 0),
  from_address  TEXT NOT NULL,
  to_address    TEXT,
  provider      TEXT NOT NULL,          -- alchemy | blockscout | logs
  sync_run_id   UUID REFERENCES sync_runs(id) ON DELETE SET NULL,
  payload       JSONB,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain, tx_hash, wallet_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_raw_transfers_wallet_block ON raw_transfers(wallet_id, block_number);

CREATE TABLE IF NOT EXISTS raw_receipts (
  wallet_id           UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  chain               TEXT NOT NULL DEFAULT 'base',
  tx_hash             TEXT NOT NULL,
  block_number        BIGINT NOT NULL,
  block_hash          TEXT,
  status              TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  from_address        TEXT NOT NULL,
  to_address          TEXT,
  gas_used            NUMERIC(78, 0) NOT NULL,
  effective_gas_price NUMERIC(78, 0) NOT NULL,
  l1_fee              NUMERIC(78, 0) NOT NULL DEFAULT 0,
  operator_fee        NUMERIC(78, 0) NOT NULL DEFAULT 0,
  fee_wei             NUMERIC(78, 0) NOT NULL,
  payload             JSONB,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, tx_hash, wallet_id)
);
CREATE INDEX IF NOT EXISTS idx_raw_receipts_wallet_block ON raw_receipts(wallet_id, block_number);

ALTER TABLE normalized_events ADD COLUMN IF NOT EXISTS raw_amount NUMERIC(78, 0);
ALTER TABLE normalized_events ADD COLUMN IF NOT EXISTS block_number BIGINT;

ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS from_block BIGINT;
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS to_block BIGINT;
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS degraded BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS rescanned_at TIMESTAMPTZ;
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS log_gaps INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sync_runs_degraded
  ON sync_runs(wallet_id, started_at) WHERE degraded AND rescanned_at IS NULL;

-- Latest verified point per wallet and asset: the on-chain balance at block_number
CREATE TABLE IF NOT EXISTS ledger_checkpoints (
  wallet_id    UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  asset        TEXT NOT NULL CHECK (asset IN ('ETH', 'USDC', 'BNKR')),
  block_number BIGINT NOT NULL,
  balance_raw  NUMERIC(78, 0) NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (wallet_id, asset)
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id    UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  asset        TEXT NOT NULL,
  from_block   BIGINT NOT NULL,
  to_block     BIGINT NOT NULL,
  expected_raw NUMERIC(78, 0),
  actual_raw   NUMERIC(78, 0),
  status       TEXT NOT NULL CHECK (status IN ('ok', 'repaired', 'drift', 'error')),
  drift_block  BIGINT,
  details      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_wallet ON reconciliation_runs(wallet_id, created_at DESC);

ALTER TABLE watch_jobs ADD COLUMN IF NOT EXISTS ledger_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE watch_jobs ADD COLUMN IF NOT EXISTS incomplete_since_block BIGINT;
ALTER TABLE watch_jobs ADD COLUMN IF NOT EXISTS incomplete_since_at TIMESTAMPTZ;
ALTER TABLE watch_jobs ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watch_jobs_ledger_status_check') THEN
    ALTER TABLE watch_jobs ADD CONSTRAINT watch_jobs_ledger_status_check
      CHECK (ledger_status IN ('unknown', 'complete', 'incomplete'));
  END IF;
END $$;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_type_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_type_check CHECK (type IN (
  'new_counterparty', 'spend_spike', 'treasury_floor',
  'round_trip', 'unknown_high', 'large_inflow', 'large_outflow',
  'unusual_gas', 'x402_anomaly', 'classifier_degradation',
  'portfolio_up', 'portfolio_down', 'pnl_positive', 'books_attention',
  'worker_stale', 'wallet_stale', 'disk_pressure', 'ledger_incomplete'
));

-- Re-read each wallet's stored history on the next sync to fill the raw tables and gas.
UPDATE watch_jobs wj
SET last_block = sub.min_block - 1, updated_at = NOW()
FROM (
  SELECT wallet_id, MIN(block_number) AS min_block
  FROM transactions
  WHERE block_number IS NOT NULL
  GROUP BY wallet_id
) sub
WHERE wj.wallet_id = sub.wallet_id;
