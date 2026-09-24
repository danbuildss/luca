-- Migration 011: Classification + ingestion correctness fixes
--
-- 1. classifications.source / attempts / retry_after
--    - source = 'user'    → written by a user correction; automated classifiers never supersede it.
--    - source = 'failure' → placeholder 'unknown' written when the classifier could not run
--                           (no API key, spend cap, batch/parse/validation failure). Retryable
--                           once retry_after has passed, up to a max attempt count.
--    - source IS NULL     → normal automated classification (incl. genuine model 'unknown').
-- 2. counterparty_rules.direction — rules learned from a correction only apply to events in
--    the same direction. NULL = legacy / any direction.
-- 3. normalized_events.source_key — stable per-transfer discriminator inside a tx, so several
--    native/internal transfers in one tx no longer collide on the unique key.
--
-- Safe on a live DB: additive columns, backfills, no data is deleted.

-- ---------------------------------------------------------------------------
-- 1. Classifications: user-sourced + retryable failures
-- ---------------------------------------------------------------------------

ALTER TABLE classifications
  ADD COLUMN IF NOT EXISTS source      TEXT,
  ADD COLUMN IF NOT EXISTS attempts    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE classifications
    ADD CONSTRAINT classifications_source_check
    CHECK (source IS NULL OR source IN ('user', 'failure'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Existing user corrections (handler.ts wrote evidence 'User correction: ...')
UPDATE classifications
SET source = 'user'
WHERE source IS NULL
  AND evidence LIKE 'User correction:%';

-- Existing stuck failure placeholders become retryable immediately
UPDATE classifications
SET source = 'failure', retry_after = NOW()
WHERE source IS NULL
  AND superseded_at IS NULL
  AND label = 'unknown'
  AND confidence = 0
  AND method = 'model'
  AND evidence = 'No rule matched and LLM unavailable or cap exceeded';

CREATE INDEX IF NOT EXISTS idx_classifications_retry
  ON classifications(retry_after)
  WHERE superseded_at IS NULL AND source = 'failure';

-- ---------------------------------------------------------------------------
-- 2. Counterparty rules: direction-aware
-- ---------------------------------------------------------------------------

ALTER TABLE counterparty_rules
  ADD COLUMN IF NOT EXISTS direction TEXT;

DO $$ BEGIN
  ALTER TABLE counterparty_rules
    ADD CONSTRAINT counterparty_rules_direction_check
    CHECK (direction IS NULL OR direction IN ('in', 'out'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Drop the old UNIQUE(user_id, address) constraint (whatever it is named).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'counterparty_rules'::regclass
      AND con.contype = 'u'
      AND (
        SELECT array_agg(att.attname::text ORDER BY att.attname::text)
        FROM unnest(con.conkey) AS k(attnum)
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
      ) = ARRAY['address', 'user_id']
  LOOP
    EXECUTE format('ALTER TABLE counterparty_rules DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- One rule per (user, address, direction); NULL direction is its own slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparty_rules_user_addr_dir
  ON counterparty_rules(user_id, address, (COALESCE(direction, '*')));

-- Backfill direction on legacy user rules when every tx correction for that
-- counterparty was on events of a single direction (and no counterparty-level
-- correction exists, which would mean "any direction").
UPDATE counterparty_rules cr
SET direction = d.dir
FROM (
  SELECT c.user_id,
         LOWER(c.counterparty_address) AS addr,
         MIN(ne.direction)             AS dir
  FROM corrections c
  JOIN normalized_events ne ON ne.id = c.event_id
  WHERE c.type = 'tx'
    AND c.counterparty_address IS NOT NULL
    AND ne.direction IS NOT NULL
  GROUP BY c.user_id, LOWER(c.counterparty_address)
  HAVING COUNT(DISTINCT ne.direction) = 1
) d
WHERE cr.user_id = d.user_id
  AND cr.address = d.addr
  AND cr.direction IS NULL
  AND cr.source = 'user'
  AND NOT EXISTS (
    SELECT 1 FROM corrections c2
    WHERE c2.user_id = cr.user_id
      AND c2.type = 'counterparty'
      AND LOWER(c2.counterparty_address) = cr.address
  );

-- ---------------------------------------------------------------------------
-- 3. Normalized events: per-transfer source_key
-- ---------------------------------------------------------------------------
-- Key formats written by ingestion:
--   'log:<n>'              ERC-20 transfer with a known log index
--   'external'             native top-level transfer (one per tx)
--   'internal:<...>'       internal (trace) transfer
--   'legacy'               rows ingested before this migration without a log index;
--                          ingestion "claims" (re-keys) them when it sees the same transfer again.

ALTER TABLE normalized_events
  ADD COLUMN IF NOT EXISTS source_key TEXT;

UPDATE normalized_events
SET source_key = CASE
  WHEN log_index IS NOT NULL THEN 'log:' || log_index::text
  ELSE 'legacy'
END
WHERE source_key IS NULL;

ALTER TABLE normalized_events ALTER COLUMN source_key SET DEFAULT 'legacy';
ALTER TABLE normalized_events ALTER COLUMN source_key SET NOT NULL;

-- Backfill maps the old key (COALESCE(log_index,-1)) injectively, so this cannot conflict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_source
  ON normalized_events(chain, hash, wallet_id, source_key);

-- The old key collapsed every log-less transfer in a tx into one slot.
DROP INDEX IF EXISTS idx_events_unique;
