-- Migration 023: label_proposals
--
-- Additive and safe to re-run. Nothing is deleted or changed.
--
-- A correction can teach a rule that would change earlier entries in the books (or
-- contradict a rule whose earlier labels should then be re-checked). Luca no longer
-- changes those entries by itself: it stores a proposal with the exact transfers it
-- would change, asks the operator in chat, and applies it only after a yes.
--
--   kind 'apply_rule': label `event_ids` with the learned rule's `label`
--   kind 'send_back':  the rule that labeled `event_ids` was switched off; send them
--                      back to unknown so the operator can answer them
--
-- status: pending until answered; expired after expires_at; superseded when a newer
-- correction for the same address and direction replaces the question.

CREATE TABLE IF NOT EXISTS label_proposals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('apply_rule', 'send_back')),
  rule_id              UUID REFERENCES counterparty_rules(id) ON DELETE SET NULL,
  correction_id        UUID REFERENCES corrections(id) ON DELETE SET NULL,
  -- The corrected transfer itself, never part of event_ids
  source_event_id      UUID REFERENCES normalized_events(id) ON DELETE SET NULL,
  counterparty_address TEXT NOT NULL,
  direction            TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  label                classification_label NOT NULL,
  event_ids            UUID[] NOT NULL,
  question             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'superseded')),
  result               JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '7 days'),
  decided_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_label_proposals_user_pending
  ON label_proposals (user_id, created_at DESC) WHERE status = 'pending';
