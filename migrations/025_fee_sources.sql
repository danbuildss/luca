-- Migration 025: creator-fee sources (ACCUM on Bankr), their readings and claim evidence
--
-- Additive and safe to re-run. Nothing is deleted and no label is added.
--
-- 1. fee_sources: one token whose trading fees are paid to one of the operator's wallets
--    (e.g. $ACCUM creator fees, paid in BNKR by Bankr's fee contract). Every figure
--    Luca gives about it is tied to this row: the pool id, fee contract and fee asset
--    Bankr reported when it was added. If Bankr later reports anything different, the
--    readings stop until an admin checks it.
-- 2. fee_source_readings: what Bankr's public API reported, hourly, exactly as received.
--    These are "reported by Bankr", never on-chain facts. A failed read is kept too, so
--    Luca can say when it last heard from Bankr and why the latest read failed.
-- 3. fee_claim_checks: for each fee-asset transfer into the fee wallet, what its
--    transaction receipt showed. Only verdict 'claim' becomes revenue with fee
--    provenance; 'unclear' (the fee contract is involved but the evidence does not tie
--    it to this pool alone) stays unknown; 'unrelated' is labeled as usual.
-- 4. classifications.fee_source_id: set only on a label backed by a 'claim' check.

CREATE TABLE IF NOT EXISTS fee_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id     UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('bankr')),
  token_address TEXT NOT NULL,          -- lowercase; the token whose trading pays the fees
  token_symbol  TEXT NOT NULL,          -- as Bankr reported it; display only, never identity
  pool_id       TEXT NOT NULL,          -- lowercase bytes32
  fee_contract  TEXT NOT NULL,          -- lowercase; the contract fees are claimed from
  fee_asset     TEXT NOT NULL CHECK (fee_asset IN ('BNKR')),
  fee_token     TEXT NOT NULL,          -- lowercase contract of fee_asset
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_id, token_address)
);
CREATE INDEX IF NOT EXISTS idx_fee_sources_user ON fee_sources(user_id) WHERE active;

CREATE TABLE IF NOT EXISTS fee_source_readings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_source_id UUID NOT NULL REFERENCES fee_sources(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  claimable     NUMERIC(78, 18),        -- fee_asset units, as Bankr reported
  claimed       NUMERIC(78, 18),
  claim_count   INTEGER,
  error         TEXT,
  raw           JSONB,
  read_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fee_source_readings_source ON fee_source_readings(fee_source_id, read_at DESC);

CREATE TABLE IF NOT EXISTS fee_claim_checks (
  event_id      UUID PRIMARY KEY REFERENCES normalized_events(id) ON DELETE CASCADE,
  fee_source_id UUID NOT NULL REFERENCES fee_sources(id) ON DELETE CASCADE,
  verdict       TEXT NOT NULL CHECK (verdict IN ('claim', 'unclear', 'unrelated')),
  evidence      JSONB NOT NULL,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fee_claim_checks_source ON fee_claim_checks(fee_source_id, verdict);

ALTER TABLE classifications ADD COLUMN IF NOT EXISTS fee_source_id UUID REFERENCES fee_sources(id) ON DELETE SET NULL;
