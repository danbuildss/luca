-- Migration 007: Gold transaction set for regression testing
-- A curated set of transactions with known-correct labels.
-- Run the classifier against these on every deploy to catch regressions.

CREATE TABLE IF NOT EXISTS gold_transactions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id        UUID        NOT NULL REFERENCES normalized_events(id),
  correct_label   TEXT        NOT NULL,  -- the ground-truth label
  notes           TEXT,                  -- why this transaction is in the set / what it tests
  added_by        TEXT        NOT NULL DEFAULT 'user',  -- 'user' | 'review'
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_gold_transactions_user_id ON gold_transactions(user_id);

-- View: gold set regression results
-- Compares current classification against gold label for each entry.
CREATE OR REPLACE VIEW gold_set_results AS
SELECT
  gt.user_id,
  gt.event_id,
  gt.correct_label,
  c.label         AS current_label,
  c.confidence    AS current_confidence,
  c.method        AS current_method,
  CASE WHEN c.label::text = gt.correct_label THEN true ELSE false END AS is_correct,
  gt.notes,
  gt.added_at
FROM gold_transactions gt
LEFT JOIN classifications c
  ON c.event_id = gt.event_id AND c.superseded_at IS NULL;

-- View: gold set summary — pass rate by label
CREATE OR REPLACE VIEW gold_set_summary AS
SELECT
  user_id,
  correct_label,
  COUNT(*)                                                           AS total,
  SUM(CASE WHEN is_correct THEN 1 ELSE 0 END)                       AS correct,
  SUM(CASE WHEN NOT is_correct THEN 1 ELSE 0 END)                   AS wrong,
  SUM(CASE WHEN is_correct THEN 1 ELSE 0 END)::numeric
    / NULLIF(COUNT(*), 0)                                            AS pass_rate
FROM gold_set_results
GROUP BY user_id, correct_label
ORDER BY pass_rate ASC;
