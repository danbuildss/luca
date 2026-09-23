-- Migration 005: Strengthen corrections table for quality metrics
-- Adds classification_id, old_confidence, and created_rule so every
-- correction links back to what was wrong and how confident we were.

ALTER TABLE corrections
  ADD COLUMN IF NOT EXISTS classification_id UUID REFERENCES classifications(id),
  ADD COLUMN IF NOT EXISTS old_confidence    NUMERIC,
  ADD COLUMN IF NOT EXISTS created_rule      BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_corrections_classification_id
  ON corrections(classification_id);

-- Backfill classification_id for existing tx corrections where we can
-- match on event_id. We use the superseded classification (the one that
-- was wrong) — find it as the most recent classification created BEFORE
-- the correction was recorded.
UPDATE corrections c
SET classification_id = (
  SELECT cl.id
  FROM classifications cl
  WHERE cl.event_id = c.event_id
    AND cl.superseded_at IS NOT NULL
    AND cl.superseded_at <= c.created_at + INTERVAL '5 seconds'
  ORDER BY cl.superseded_at DESC
  LIMIT 1
)
WHERE c.type = 'tx'
  AND c.event_id IS NOT NULL
  AND c.classification_id IS NULL;

-- Backfill old_confidence from the linked classification
UPDATE corrections c
SET old_confidence = cl.confidence
FROM classifications cl
WHERE c.classification_id = cl.id
  AND c.old_confidence IS NULL;
