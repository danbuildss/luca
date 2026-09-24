-- Migration 014: identify assets by contract, keep unsupported transfers, safe sync cursor
--
-- Additive and safe to re-run. Nothing is deleted.
--
-- 1. normalized_events.token_address (NULL for native ETH) and supported
--    (TRUE = ETH/USDC/BNKR, FALSE = any other token, NULL = not verified yet).
--    Every read path shows only supported IS TRUE rows.
-- 2. Backfill what stored data proves: native transfers are ETH; ERC-20 rows whose
--    transaction raw payload is that exact log get its contract.
-- 3. Labels on unsupported events are retired (superseded, kept in history).
-- 4. BNKR values priced with a later day's spot price are cleared.
-- 5. sync_runs gains failed_count and a 'partial' status.
-- 6. Each wallet's cursor rewinds to its oldest stored block so the next sync
--    re-reads its history and fills token_address/supported exactly.

ALTER TABLE normalized_events ADD COLUMN IF NOT EXISTS token_address TEXT;
ALTER TABLE normalized_events ADD COLUMN IF NOT EXISTS supported BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_events_user_supported_time
  ON normalized_events(user_id, block_time DESC) WHERE supported IS TRUE;

-- Native ETH: Alchemy 'external'/'internal' transfers and Blockscout native txs.
UPDATE normalized_events
SET supported = TRUE, token_address = NULL, asset = 'ETH'
WHERE supported IS NULL
  AND (source_key = 'external' OR source_key LIKE 'internal:%');

-- ERC-20 rows whose transaction's stored raw payload is this exact log.
UPDATE normalized_events ne
SET token_address = LOWER(COALESCE(
      t.raw_payload->'rawContract'->>'address',
      t.raw_payload->'token'->>'address'))
FROM transactions t
WHERE t.id = ne.transaction_id
  AND ne.supported IS NULL
  AND ne.token_address IS NULL
  AND ne.log_index IS NOT NULL
  AND (
    (split_part(t.raw_payload->>'uniqueId', ':', 2) = 'log'
      AND split_part(t.raw_payload->>'uniqueId', ':', 3) = ne.log_index::text)
    OR (t.raw_payload->>'log_index') = ne.log_index::text
  )
  AND COALESCE(t.raw_payload->'rawContract'->>'address', t.raw_payload->'token'->>'address') IS NOT NULL;

UPDATE normalized_events
SET supported = token_address IN (
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',  -- USDC (Base)
      '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b'   -- BNKR (Base)
    ),
    asset = CASE token_address
      WHEN '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' THEN 'USDC'
      WHEN '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b' THEN 'BNKR'
      ELSE asset
    END
WHERE supported IS NULL AND token_address IS NOT NULL;

-- Retire labels on unsupported events so books, alerts and quality views skip them.
UPDATE classifications c
SET superseded_at = NOW()
FROM normalized_events ne
WHERE c.event_id = ne.id
  AND ne.supported = FALSE
  AND c.superseded_at IS NULL;

-- BNKR was priced at the spot price on the day it was ingested, not the day it moved.
UPDATE normalized_events
SET usd_value = NULL, price_source = 'unavailable', price_at = NULL
WHERE asset = 'BNKR'
  AND price_source = 'coingecko'
  AND created_at - block_time > INTERVAL '1 hour';

-- sync_runs: record partial runs and how many transfers failed to store.
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS failed_count INTEGER NOT NULL DEFAULT 0;

DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'sync_runs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE sync_runs DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_status_check
  CHECK (status IN ('running', 'completed', 'partial', 'failed'));

-- Re-read each wallet's full stored history on the next sync.
UPDATE watch_jobs wj
SET last_block = sub.min_block - 1, updated_at = NOW()
FROM (
  SELECT wallet_id, MIN(block_number) AS min_block
  FROM transactions
  WHERE block_number IS NOT NULL
  GROUP BY wallet_id
) sub
WHERE wj.wallet_id = sub.wallet_id;
