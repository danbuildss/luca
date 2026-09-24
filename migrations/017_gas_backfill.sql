-- Migration 017: re-read history for gas, and keep zero-value transfers out of the books
--
-- Additive and safe to re-run. Nothing is deleted.
--
-- 1. Blockscout's transaction list names the block field block_number. Luca read the old
--    name, so the first sync after 016 recorded no gas at all. Cursors rewind to each
--    wallet's oldest stored block so the next sync records it.
-- 2. A transfer of zero moves no money. Most are address-poisoning spam that looks like a
--    payment from the user's wallet. They stay as evidence but leave the books, and any
--    label on them is retired.
-- 3. The balance check runs again right after that sync.

UPDATE normalized_events
SET supported = FALSE
WHERE supported IS TRUE
  AND source_key <> 'gas'
  AND (raw_amount = 0 OR (raw_amount IS NULL AND amount = 0));

UPDATE classifications c
SET superseded_at = NOW()
FROM normalized_events ne
WHERE c.event_id = ne.id
  AND ne.supported = FALSE
  AND c.superseded_at IS NULL;

UPDATE watch_jobs wj
SET last_block = sub.min_block - 1, last_reconciled_at = NULL, updated_at = NOW()
FROM (
  SELECT wallet_id, MIN(block_number) AS min_block
  FROM transactions
  WHERE block_number IS NOT NULL
  GROUP BY wallet_id
) sub
WHERE wj.wallet_id = sub.wallet_id;
