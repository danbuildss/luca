-- Migration 008: Root cause tagging on corrections
-- Adds a failure_reason enum so every correction can record WHY the classifier was wrong.
-- Nullable — existing corrections and corrections where the user doesn't tag are fine.

CREATE TYPE correction_failure_reason AS ENUM (
  'bad_rule',             -- a deterministic rule fired incorrectly
  'missing_counterparty', -- counterparty not in rules; would have been caught with a rule
  'bad_model_inference',  -- LLM or pattern model guessed wrong
  'missing_protocol',     -- protocol not recognized by any classifier
  'bad_data'              -- underlying transaction data was incomplete or incorrect
);

ALTER TABLE corrections
  ADD COLUMN IF NOT EXISTS failure_reason correction_failure_reason;

CREATE INDEX IF NOT EXISTS idx_corrections_failure_reason
  ON corrections(user_id, failure_reason)
  WHERE failure_reason IS NOT NULL;
