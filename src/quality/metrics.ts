import { query } from '../db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MethodErrorRate = {
  method: string;
  total_classified: number;
  corrected: number;
  error_rate: number;
  avg_confidence_at_error: number | null;
};

export type CalibrationBucket = {
  bucket: number; // 1–10 (bucket 1 = 0.0–0.1, bucket 10 = 0.9–1.0)
  avg_confidence: number;
  total: number;
  corrected: number;
  observed_accuracy: number;
};

export type CounterpartyCluster = {
  counterparty_address: string;
  correction_count: number;
  most_common_correction: string | null;
};

export type LabelPrecision = {
  predicted_label: string;
  total: number;
  false_positives: number;
  precision_proxy: number;
};

export type UnknownDecomposition = {
  classifier_weakness: number;      // unknown corrected to label with confidence > 0.8
  repeated_counterparties: number;  // counterparty addresses with 3+ unknowns
  total_unknown: number;
};

export type QualityHealthSnapshot = {
  period_days: number;
  total_classified: number;
  unknown_count: number;
  unknown_pct: number;
  correction_count: number;
  correction_pct: number;
  high_confidence_errors: number;   // confidence > 0.8 at time of correction
};

// ---------------------------------------------------------------------------
// Health snapshot — 7-day window
// ---------------------------------------------------------------------------

export async function getHealthSnapshot(
  userId: string,
  days = 7,
): Promise<QualityHealthSnapshot> {
  const res = await query<{
    total_classified: string;
    unknown_count: string;
    correction_count: string;
    high_confidence_errors: string;
  }>(
    `SELECT
       COUNT(DISTINCT c.id)::text AS total_classified,
       COUNT(DISTINCT c.id) FILTER (WHERE c.label = 'unknown')::text AS unknown_count,
       COUNT(DISTINCT cr.id)::text AS correction_count,
       COUNT(DISTINCT cr.id) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM classifications c2
           WHERE c2.event_id = cr.event_id
             AND c2.superseded_at IS NOT NULL
             AND c2.confidence > 0.8
             AND c2.label = cr.old_label
         )
       )::text AS high_confidence_errors
     FROM classifications c
     LEFT JOIN corrections cr ON cr.event_id = c.event_id
       AND cr.user_id = $1
       AND cr.created_at >= NOW() - ($2 || ' days')::INTERVAL
     WHERE c.user_id = $1
       AND c.created_at >= NOW() - ($2 || ' days')::INTERVAL
       AND c.superseded_at IS NULL`,
    [userId, days.toString()],
  );

  const row = res.rows[0] ?? {
    total_classified: '0',
    unknown_count: '0',
    correction_count: '0',
    high_confidence_errors: '0',
  };

  const total = parseInt(row.total_classified);
  const unknown = parseInt(row.unknown_count);
  const corrections = parseInt(row.correction_count);
  const hce = parseInt(row.high_confidence_errors);

  return {
    period_days: days,
    total_classified: total,
    unknown_count: unknown,
    unknown_pct: total > 0 ? (unknown / total) * 100 : 0,
    correction_count: corrections,
    correction_pct: total > 0 ? (corrections / total) * 100 : 0,
    high_confidence_errors: hce,
  };
}

// ---------------------------------------------------------------------------
// Error rate by method — among classifications with confidence > 0.8
// ---------------------------------------------------------------------------

export async function getMethodErrorRates(userId: string): Promise<MethodErrorRate[]> {
  const res = await query<{
    method: string;
    total_classified: string;
    corrected: string;
    avg_confidence_at_error: string | null;
  }>(
    `SELECT
       c.method,
       COUNT(*)::text AS total_classified,
       COUNT(cr.id)::text AS corrected,
       AVG(c.confidence) FILTER (WHERE cr.id IS NOT NULL)::text AS avg_confidence_at_error
     FROM classifications c
     LEFT JOIN corrections cr ON cr.event_id = c.event_id
       AND cr.user_id = $1
       AND cr.old_label IS NOT NULL
     WHERE c.user_id = $1
       AND c.confidence > 0.8
       AND c.superseded_at IS NULL
     GROUP BY c.method
     ORDER BY COUNT(cr.id)::float / NULLIF(COUNT(*), 0) DESC`,
    [userId],
  );

  return res.rows.map((r) => ({
    method: r.method,
    total_classified: parseInt(r.total_classified),
    corrected: parseInt(r.corrected),
    error_rate: parseInt(r.total_classified) > 0
      ? parseInt(r.corrected) / parseInt(r.total_classified)
      : 0,
    avg_confidence_at_error: r.avg_confidence_at_error
      ? parseFloat(r.avg_confidence_at_error)
      : null,
  }));
}

// ---------------------------------------------------------------------------
// Calibration buckets — are confidence scores honest?
// ---------------------------------------------------------------------------

export async function getCalibrationBuckets(userId: string): Promise<CalibrationBucket[]> {
  const res = await query<{
    bucket: string;
    avg_confidence: string;
    total: string;
    corrected: string;
  }>(
    `SELECT
       width_bucket(c.confidence, 0, 1, 10)::text AS bucket,
       ROUND(AVG(c.confidence)::numeric, 2)::text AS avg_confidence,
       COUNT(*)::text AS total,
       COUNT(cr.id)::text AS corrected
     FROM classifications c
     LEFT JOIN corrections cr ON cr.event_id = c.event_id
       AND cr.user_id = $1
       AND cr.old_label IS NOT NULL
     WHERE c.user_id = $1
       AND c.superseded_at IS NULL
       AND c.confidence IS NOT NULL
     GROUP BY width_bucket(c.confidence, 0, 1, 10)
     ORDER BY bucket`,
    [userId],
  );

  return res.rows.map((r) => {
    const total = parseInt(r.total);
    const corrected = parseInt(r.corrected);
    return {
      bucket: parseInt(r.bucket),
      avg_confidence: parseFloat(r.avg_confidence),
      total,
      corrected,
      observed_accuracy: total > 0 ? 1 - corrected / total : 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Counterparties generating repeated corrections
// ---------------------------------------------------------------------------

export async function getCounterpartyCorrections(
  userId: string,
  minCount = 2,
): Promise<CounterpartyCluster[]> {
  const res = await query<{
    counterparty_address: string;
    correction_count: string;
    most_common_correction: string | null;
  }>(
    `SELECT
       cr.counterparty_address,
       COUNT(*)::text AS correction_count,
       MODE() WITHIN GROUP (ORDER BY cr.new_label) AS most_common_correction
     FROM corrections cr
     WHERE cr.user_id = $1
       AND cr.counterparty_address IS NOT NULL
       AND cr.type = 'tx'
     GROUP BY cr.counterparty_address
     HAVING COUNT(*) >= $2
     ORDER BY COUNT(*) DESC
     LIMIT 10`,
    [userId, minCount],
  );

  return res.rows.map((r) => ({
    counterparty_address: r.counterparty_address,
    correction_count: parseInt(r.correction_count),
    most_common_correction: r.most_common_correction,
  }));
}

// ---------------------------------------------------------------------------
// Label precision proxy — classifications corrected by label
// ---------------------------------------------------------------------------

export async function getLabelPrecision(userId: string): Promise<LabelPrecision[]> {
  const res = await query<{
    predicted_label: string;
    total: string;
    false_positives: string;
  }>(
    `SELECT
       c.label AS predicted_label,
       COUNT(*)::text AS total,
       COUNT(cr.id)::text AS false_positives
     FROM classifications c
     LEFT JOIN corrections cr ON cr.event_id = c.event_id
       AND cr.user_id = $1
       AND cr.old_label = c.label
     WHERE c.user_id = $1
       AND c.superseded_at IS NULL
     GROUP BY c.label
     ORDER BY COUNT(cr.id)::float / NULLIF(COUNT(*), 0) DESC`,
    [userId],
  );

  return res.rows.map((r) => {
    const total = parseInt(r.total);
    const fp = parseInt(r.false_positives);
    return {
      predicted_label: r.predicted_label,
      total,
      false_positives: fp,
      precision_proxy: total > 0 ? 1 - fp / total : 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Unknown decomposition
// ---------------------------------------------------------------------------

export async function getUnknownDecomposition(userId: string): Promise<UnknownDecomposition> {
  const [weaknessRes, counterpartyRes, totalRes] = await Promise.all([
    // Classifier weakness: unknowns corrected to a confident label
    query<{ count: string }>(
      `SELECT COUNT(DISTINCT cr.event_id)::text AS count
       FROM corrections cr
       JOIN normalized_events ne ON ne.id = cr.event_id
       WHERE cr.user_id = $1
         AND cr.old_label = 'unknown'
         AND cr.new_label != 'unknown'`,
      [userId],
    ),

    // Missing rules: counterparties with 3+ unknowns
    query<{ count: string }>(
      `SELECT COUNT(DISTINCT sub.counterparty_address)::text AS count
       FROM (
         SELECT cr.counterparty_address
         FROM corrections cr
         WHERE cr.user_id = $1
           AND cr.old_label = 'unknown'
           AND cr.counterparty_address IS NOT NULL
         UNION ALL
         SELECT CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END
         FROM classifications c
         JOIN normalized_events ne ON ne.id = c.event_id
         WHERE c.user_id = $1
           AND c.label = 'unknown'
           AND c.superseded_at IS NULL
       ) sub
       WHERE sub.counterparty_address IS NOT NULL
       GROUP BY sub.counterparty_address
       HAVING COUNT(*) >= 3`,
      [userId],
    ),

    // Total current unknowns
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM classifications c
       WHERE c.user_id = $1
         AND c.label = 'unknown'
         AND c.superseded_at IS NULL`,
      [userId],
    ),
  ]);

  return {
    classifier_weakness: parseInt(weaknessRes.rows[0]?.count ?? '0'),
    repeated_counterparties: parseInt(counterpartyRes.rows[0]?.count ?? '0'),
    total_unknown: parseInt(totalRes.rows[0]?.count ?? '0'),
  };
}

// ---------------------------------------------------------------------------
// High-confidence error rate — the fire alarm
// Threshold: confidence > 0.8 at correction time
// Returns rate as a number 0–1
// ---------------------------------------------------------------------------

export async function getHighConfidenceErrorRate(userId: string): Promise<{
  rate: number;
  count: number;
  total_high_confidence: number;
}> {
  const res = await query<{
    total_high_conf: string;
    error_count: string;
  }>(
    `SELECT
       COUNT(DISTINCT c.id)::text AS total_high_conf,
       COUNT(DISTINCT cr.id)::text AS error_count
     FROM classifications c
     LEFT JOIN corrections cr ON cr.event_id = c.event_id
       AND cr.user_id = $1
       AND cr.old_label IS NOT NULL
     WHERE c.user_id = $1
       AND c.confidence > 0.8
       AND c.superseded_at IS NULL`,
    [userId],
  );

  const row = res.rows[0];
  const total = parseInt(row?.total_high_conf ?? '0');
  const errors = parseInt(row?.error_count ?? '0');
  return {
    rate: total > 0 ? errors / total : 0,
    count: errors,
    total_high_confidence: total,
  };
}
