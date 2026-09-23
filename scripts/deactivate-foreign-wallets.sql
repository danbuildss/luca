-- Deactivate wallets that don't belong to the operator.
-- These were test/foreign wallets added during development.
-- Rows are kept for audit; active = false stops all future syncing.
-- Run on VPS: psql "$DATABASE_URL" -f scripts/deactivate-foreign-wallets.sql

UPDATE wallets
SET active = false
WHERE address IN (
  '0xf1e958db7d1e4c074377946018ad645db4fb158e',  -- foreign treasury
  '0x67976cebb5266b50a08c0dcb676e03baf305e3a2'   -- foreign deployer
);
