-- Migration 030: decision history (data compounds, Oct 5 2026)
--
-- Additive. Nothing is deleted or rewritten. Keeps what Luca decided and why, what the
-- operator changed, and what that caused, instead of overwriting it.
--
-- 1. classifications.model / prompt_version / inputs: for an AI label, the model, a
--    fingerprint of the classifier instructions, and exactly what the model was shown for
--    that transfer. Null for labels made before this migration and for non-AI labels.
-- 2. corrections.rule_id / new_classification_id: the rule a correction taught and the
--    label row it created (classification_id already points at the row it replaced).
--    corrections.source_message (the operator's own words) exists since 001 and is now
--    filled. label_proposals.operator_message keeps those words until the yes.
-- 3. rule_events: append-only history of each counterparty rule (created, label or name
--    changed, switched off, switched back on), before and after, and what caused it.
-- 4. question_events: append-only history of each question group (asked, answered,
--    skipped, closed), so how often something was asked and how long an answer took
--    survive; question_groups keeps only the current state.
-- 5. price_revisions: the dollar value an event had before repricing replaced it.
--
-- Backfills: one 'existing' snapshot per rule, so every rule's history has a start, and
-- corrections.rule_id where a proposal already recorded the link.

ALTER TABLE classifications ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE classifications ADD COLUMN IF NOT EXISTS prompt_version TEXT;
ALTER TABLE classifications ADD COLUMN IF NOT EXISTS inputs JSONB;

ALTER TABLE corrections ADD COLUMN IF NOT EXISTS rule_id UUID REFERENCES counterparty_rules(id) ON DELETE SET NULL;
ALTER TABLE corrections ADD COLUMN IF NOT EXISTS new_classification_id UUID REFERENCES classifications(id) ON DELETE SET NULL;
ALTER TABLE label_proposals ADD COLUMN IF NOT EXISTS operator_message TEXT;

CREATE TABLE IF NOT EXISTS rule_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id        UUID NOT NULL REFERENCES counterparty_rules(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event          TEXT NOT NULL CHECK (event IN ('existing', 'created', 'changed', 'disabled', 'reenabled')),
  before         JSONB,               -- label, name, active, disabled_reason before
  after          JSONB NOT NULL,      -- the same after
  correction_id  UUID REFERENCES corrections(id) ON DELETE SET NULL,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_rule_events_rule ON rule_events(rule_id, created_at);

CREATE TABLE IF NOT EXISTS question_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       UUID NOT NULL REFERENCES question_groups(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event          TEXT NOT NULL CHECK (event IN ('asked', 'answered', 'skipped', 'closed')),
  channel        TEXT CHECK (channel IN ('morning', 'alert')),
  item           INT,                 -- its number in the list asked, if any
  event_count    INT,
  total_usd      NUMERIC,
  label          TEXT,                -- for 'answered'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_question_events_group ON question_events(group_id, created_at);

CREATE TABLE IF NOT EXISTS price_revisions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES normalized_events(id) ON DELETE CASCADE,
  old_usd_value    NUMERIC NOT NULL,
  old_price_source TEXT,
  old_price_at     TIMESTAMPTZ,
  new_usd_value    NUMERIC,
  new_price_source TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_price_revisions_event ON price_revisions(event_id);

-- Backfill: every existing rule's history starts with what it is now
INSERT INTO rule_events (rule_id, user_id, event, before, after, reason, created_at)
SELECT r.id, r.user_id, 'existing', NULL,
       jsonb_build_object('label', r.label::text, 'name', r.name, 'direction', r.direction,
                          'active', r.active, 'disabled_reason', r.disabled_reason),
       'Existed before migration 030', NOW()
FROM counterparty_rules r
WHERE NOT EXISTS (SELECT 1 FROM rule_events e WHERE e.rule_id = r.id);

-- Backfill: the rule a correction taught, where a proposal recorded it
UPDATE corrections c
SET rule_id = p.rule_id
FROM label_proposals p
WHERE p.correction_id = c.id AND p.rule_id IS NOT NULL AND c.rule_id IS NULL;
