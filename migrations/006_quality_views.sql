-- Migration 006: Quality report SQL views
-- Replaces application-layer metrics with queryable views.
-- All views accept user_id filtering; date range slicing via WHERE on block_time.

-- ---------------------------------------------------------------------------
-- View: quality_corrections_detail
-- Every correction with full context: what was wrong, how confident, root cause.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW quality_corrections_detail AS
SELECT
  cr.id                     AS correction_id,
  cr.user_id,
  cr.event_id,
  cr.created_at             AS corrected_at,
  cr.old_label,
  cr.new_label,
  cr.old_confidence,
  cr.classification_id,
  cr.created_rule,
  cr.reason                 AS user_context,
  cl.method                 AS old_method,
  cl.confidence             AS confirmed_old_confidence,
  ne.block_time,
  ne.asset,
  ne.direction,
  ne.from_address,
  ne.to_address,
  CASE ne.direction
    WHEN 'in'  THEN ne.from_address
    WHEN 'out' THEN ne.to_address
  END                       AS counterparty_address
FROM corrections cr
LEFT JOIN classifications cl ON cl.id = cr.classification_id
LEFT JOIN normalized_events ne ON ne.id = cr.event_id
WHERE cr.type = 'tx';

-- ---------------------------------------------------------------------------
-- View: quality_high_confidence_errors
-- Corrections where we were confident but wrong (confidence > 0.8).
-- This is the fire alarm.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW quality_high_confidence_errors AS
SELECT
  qcd.*,
  CASE
    WHEN qcd.old_confidence >= 0.95 THEN 'critical'
    WHEN qcd.old_confidence >= 0.8  THEN 'high'
    ELSE 'medium'
  END AS severity
FROM quality_corrections_detail qcd
WHERE COALESCE(qcd.old_confidence, qcd.confirmed_old_confidence, 0) > 0.8
ORDER BY qcd.old_confidence DESC NULLS LAST, qcd.corrected_at DESC;

-- ---------------------------------------------------------------------------
-- View: quality_calibration_buckets
-- Stated confidence vs observed accuracy, grouped into decile buckets.
-- Watch for gaps > 0.15 between avg_confidence and observed_accuracy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW quality_calibration_buckets AS
SELECT
  c.user_id,
  FLOOR(c.confidence * 10)::int                                        AS bucket,
  COUNT(*)                                                             AS total,
  AVG(c.confidence)                                                    AS avg_confidence,
  SUM(CASE WHEN cr.id IS NULL THEN 1 ELSE 0 END)::numeric / COUNT(*) AS observed_accuracy,
  SUM(CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END)                  AS error_count
FROM classifications c
LEFT JOIN corrections cr ON cr.classification_id = c.id
WHERE c.superseded_at IS NOT NULL  -- only classifications that have been evaluated
   OR cr.id IS NOT NULL
GROUP BY c.user_id, FLOOR(c.confidence * 10)::int;

-- ---------------------------------------------------------------------------
-- View: quality_method_error_rates
-- Error rate by classification method, for high-confidence classifications only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW quality_method_error_rates AS
SELECT
  c.user_id,
  c.method,
  COUNT(*)                                                              AS total_high_conf,
  SUM(CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END)                   AS error_count,
  SUM(CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END)::numeric
    / NULLIF(COUNT(*), 0)                                               AS error_rate,
  AVG(CASE WHEN cr.id IS NOT NULL THEN c.confidence END)               AS avg_confidence_at_error
FROM classifications c
LEFT JOIN corrections cr ON cr.classification_id = c.id
WHERE c.confidence > 0.8
GROUP BY c.user_id, c.method;

-- ---------------------------------------------------------------------------
-- View: quality_label_precision
-- Precision proxy per label: what fraction of high-conf predictions were correct.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW quality_label_precision AS
SELECT
  c.user_id,
  c.label                                                               AS predicted_label,
  COUNT(*)                                                              AS total,
  SUM(CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END)                   AS false_positives,
  1.0 - SUM(CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*), 0)                                           AS precision_proxy
FROM classifications c
LEFT JOIN corrections cr ON cr.classification_id = c.id
WHERE c.confidence > 0.8
GROUP BY c.user_id, c.label;

-- ---------------------------------------------------------------------------
-- View: quality_weekly_trend
-- Correction rate and unknown rate week over week.
-- Join with normalized_events to get block_time for date bucketing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW quality_weekly_trend AS
SELECT
  c.user_id,
  DATE_TRUNC('week', ne.block_time)                                    AS week_start,
  COUNT(*)                                                             AS total_classified,
  SUM(CASE WHEN c.label = 'unknown' THEN 1 ELSE 0 END)                AS unknown_count,
  SUM(CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END)                  AS correction_count,
  SUM(CASE WHEN c.label = 'unknown' THEN 1 ELSE 0 END)::numeric
    / NULLIF(COUNT(*), 0)                                              AS unknown_rate,
  SUM(CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END)::numeric
    / NULLIF(COUNT(*), 0)                                              AS correction_rate
FROM classifications c
JOIN normalized_events ne ON ne.id = c.event_id
LEFT JOIN corrections cr ON cr.classification_id = c.id
WHERE c.superseded_at IS NULL
GROUP BY c.user_id, DATE_TRUNC('week', ne.block_time)
ORDER BY c.user_id, week_start;
