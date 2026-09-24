-- Migration 018: smarter classification
--
-- Additive and safe to re-run. Nothing is deleted.
--
-- 1. New label 'swap': one asset converted into another inside a single transaction.
--    Neither revenue nor expense; only its gas counts.
-- 2. classifications.status (derived, always in step with label and method):
--      unknown     - label is unknown
--      provisional - the AI's guess
--      confirmed   - a fixed rule, the operator, or a rule learned from the operator
--    classifications.shape: what the whole transaction looked like when it was labeled
--      (gas | internal | swap | single | complex). NULL on labels written before this
--      migration; the worker re-checks those once.
--    classifications.rule_id: the learned rule that produced the label, if any.
-- 3. counterparty_rules.active: a rule is switched off (kept, not deleted) when the
--    operator corrects something it labeled.
-- 4. question_groups: one open question per group of similar unknown transfers
--    (address, direction, token).

ALTER TYPE classification_label ADD VALUE IF NOT EXISTS 'swap';

ALTER TABLE classifications ADD COLUMN IF NOT EXISTS status TEXT GENERATED ALWAYS AS (
  CASE
    WHEN label = 'unknown' THEN 'unknown'
    WHEN method = 'model' THEN 'provisional'
    ELSE 'confirmed'
  END
) STORED;

ALTER TABLE classifications ADD COLUMN IF NOT EXISTS shape TEXT;
DO $$ BEGIN
  ALTER TABLE classifications ADD CONSTRAINT classifications_shape_check
    CHECK (shape IS NULL OR shape IN ('gas', 'internal', 'swap', 'single', 'complex'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE classifications ADD COLUMN IF NOT EXISTS rule_id UUID
  REFERENCES counterparty_rules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_classifications_reshape
  ON classifications(user_id)
  WHERE superseded_at IS NULL AND shape IS NULL AND source IS NULL;

ALTER TABLE counterparty_rules ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE counterparty_rules ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE counterparty_rules ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

CREATE TABLE IF NOT EXISTS question_groups (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  counterparty_address TEXT NOT NULL,                  -- lowercase
  direction            TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  asset_key            TEXT NOT NULL,                  -- token contract (lowercase) or 'eth'
  asset                TEXT,                           -- symbol, for display
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'labeled', 'skipped')),
  event_count          INTEGER NOT NULL DEFAULT 0,     -- unknown transfers in the group now
  total_usd            NUMERIC NOT NULL DEFAULT 0,     -- their priced total
  unpriced_count       INTEGER NOT NULL DEFAULT 0,
  first_at             TIMESTAMPTZ,
  last_at              TIMESTAMPTZ,
  asked_total_usd      NUMERIC,                        -- total when last asked or skipped
  asked_count          INTEGER,
  telegram_message_id  BIGINT,
  sent_at              TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, counterparty_address, direction, asset_key)
);
CREATE INDEX IF NOT EXISTS idx_question_groups_open ON question_groups(user_id) WHERE status = 'open';
