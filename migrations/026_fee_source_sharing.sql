-- Migration 026: an owner can share a fee source's read-only view with other Luca users
--
-- Additive and safe to re-run. Every source stays private (shared = FALSE) until its
-- owner turns sharing on.
--
-- A shared source's view is built from the fee tables only: Bankr's readings, the
-- verified claims (amount, time, transaction) and the reconciliation, plus the fee
-- wallet's balance of the fee asset. Nothing else of the owner's is read for it: no
-- other transactions, labels, wallets, figures or identity.

ALTER TABLE fee_sources ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fee_sources ADD COLUMN IF NOT EXISTS shared_changed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_fee_sources_shared ON fee_sources(shared) WHERE shared AND active;
