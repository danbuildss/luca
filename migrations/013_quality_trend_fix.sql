-- Migration 013: fix correction_count in quality_weekly_trend
--
-- corrections.classification_id points at the superseded (wrong)
-- classification, but this view only looks at active rows
-- (superseded_at IS NULL), so the old join never matched and
-- correction_count was always 0. Match on the event instead.
-- EXISTS avoids double-counting events corrected more than once.

CREATE OR REPLACE VIEW quality_weekly_trend AS
SELECT
  c.user_id,
  DATE_TRUNC('week', ne.block_time)                                    AS week_start,
  COUNT(*)                                                             AS total_classified,
  SUM(CASE WHEN c.label = 'unknown' THEN 1 ELSE 0 END)                AS unknown_count,
  SUM(CASE WHEN corrected.hit THEN 1 ELSE 0 END)                      AS correction_count,
  SUM(CASE WHEN c.label = 'unknown' THEN 1 ELSE 0 END)::numeric
    / NULLIF(COUNT(*), 0)                                              AS unknown_rate,
  SUM(CASE WHEN corrected.hit THEN 1 ELSE 0 END)::numeric
    / NULLIF(COUNT(*), 0)                                              AS correction_rate
FROM classifications c
JOIN normalized_events ne ON ne.id = c.event_id
CROSS JOIN LATERAL (
  SELECT EXISTS (
    SELECT 1 FROM corrections cr
    WHERE cr.event_id = c.event_id AND cr.type = 'tx'
  ) AS hit
) corrected
WHERE c.superseded_at IS NULL
GROUP BY c.user_id, DATE_TRUNC('week', ne.block_time)
ORDER BY c.user_id, week_start;
