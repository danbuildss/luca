import { query } from '../db.js';
import { usdValueSql } from '../ingestion/assets.js';
import { formatAddress } from '../telegram/format.js';
import { getHighConfidenceErrorRate } from '../quality/metrics.js';

type AlertType =
  | 'large_inflow'
  | 'large_outflow'
  | 'spend_spike'
  | 'treasury_floor'
  | 'unusual_gas'
  | 'classifier_degradation';

// verified: complete data; suspected: a real signal on partial data (e.g. AI-guessed
// labels); data_issue: about Luca's data, never a financial claim
type Certainty = 'verified' | 'suspected' | 'data_issue';

type NewAlert = {
  userId: string;
  type: AlertType;
  certainty: Certainty;
  message: string;
  evidence: Record<string, unknown>;
  dedupKey: string;
};

// Returns true when a new alert row was inserted (false = dedup hit, already exists)
async function insertAlert(alert: NewAlert): Promise<boolean> {
  const res = await query<{ id: string }>(
    `INSERT INTO alerts (user_id, type, message, evidence, dedup_key, certainty)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [alert.userId, alert.type, alert.message, JSON.stringify(alert.evidence), alert.dedupKey, alert.certainty],
  );
  return res.rows.length > 0;
}

// Rolling-window alerts (spikes, floors) must not re-fire just because the UTC date
// rolled over. Instead of a per-date dedup key, skip the insert when an alert of the
// same type (optionally scoped to one evidence field, e.g. wallet_id) was created for
// the user within the cooldown. dedup_key stays unique per insert so ON CONFLICT
// keeps working for the table's other writers.
const USD = usdValueSql('ne');
const ALERT_COOLDOWN_HOURS = 24;

async function insertAlertWithCooldown(
  alert: NewAlert,
  scope?: { evidenceKey: string; value: string },
): Promise<boolean> {
  const res = await query<{ id: string }>(
    `INSERT INTO alerts (user_id, type, message, evidence, dedup_key, certainty)
     SELECT $1::uuid, $2::text, $3::text, $4::jsonb, $5::text, $9::text
     WHERE NOT EXISTS (
       SELECT 1 FROM alerts a
       WHERE a.user_id = $1::uuid
         AND a.type = $2::text
         AND a.created_at > NOW() - make_interval(hours => $6::int)
         AND ($7::text IS NULL OR a.evidence->>$7::text = $8::text)
     )
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [
      alert.userId,
      alert.type,
      alert.message,
      JSON.stringify(alert.evidence),
      alert.dedupKey,
      ALERT_COOLDOWN_HOURS,
      scope?.evidenceKey ?? null,
      scope?.value ?? null,
      alert.certainty,
    ],
  );
  return res.rows.length > 0;
}

// Spike baselines: compare the last 24h against the daily average of the 6 days
// BEFORE it (days 2–7). Including the last 24h in the baseline would dilute it by
// the spike itself (a 5× gas spike could then never reach 5×).
const BASELINE_DAYS = 6;

// Only alert on movements that happened recently — a 30-day wallet backfill or a
// lowered materiality_usd must not alert on every historic transaction.
const LARGE_MOVEMENT_WINDOW = '24 hours';

// ---------------------------------------------------------------------------
// Detector: large_inflow / large_outflow
// Fires once per event where usd_value (or USDC amount) >= materiality_usd,
// for events with block_time in the last 24h only.
// Excludes: gas, internal_transfer, x402_income, x402_spend (those have own labels)
// ---------------------------------------------------------------------------
export async function detectLargeMovements(userId: string): Promise<number> {
  const res = await query<{
    event_id: string;
    direction: 'in' | 'out';
    asset: string | null;
    amount: string | null;
    usd_value: string | null;
    from_address: string;
    to_address: string | null;
    wallet_label: string | null;
    wallet_address: string;
    materiality_usd: string;
  }>(
    `SELECT
       ne.id AS event_id, ne.direction, ne.asset, ne.amount::text, ne.usd_value::text,
       ne.from_address, ne.to_address,
       w.label AS wallet_label, w.address AS wallet_address,
       u.materiality_usd::text
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     JOIN wallets w ON w.id = ne.wallet_id
     JOIN users u ON u.id = ne.user_id
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND c.superseded_at IS NULL
       AND c.label NOT IN ('gas', 'internal_transfer', 'x402_income', 'x402_spend')
       AND ne.block_time >= NOW() - INTERVAL '${LARGE_MOVEMENT_WINDOW}'
       AND ${USD}
           >= u.materiality_usd
       AND NOT EXISTS (
         SELECT 1 FROM alerts a
         WHERE a.dedup_key IN (
           'large_inflow:' || ne.id::text,
           'large_outflow:' || ne.id::text
         )
       )`,
    [userId],
  );

  let count = 0;
  for (const row of res.rows) {
    const usd = parseFloat(row.usd_value ?? row.amount ?? '0');
    const type: AlertType = row.direction === 'in' ? 'large_inflow' : 'large_outflow';
    const verb = row.direction === 'in' ? 'came in from' : 'went out to';
    const counterparty = row.direction === 'in'
      ? formatAddress(row.from_address)
      : row.to_address ? formatAddress(row.to_address) : '—';
    const walletHint = row.wallet_label
      ? `${formatAddress(row.wallet_address)} (${row.wallet_label})`
      : formatAddress(row.wallet_address);

    const message = [
      `${type === 'large_inflow' ? 'Large inflow' : 'Large outflow'}`,
      `$${usd.toFixed(2)} in ${row.asset ?? 'tokens'} ${verb} ${counterparty}, on ${walletHint}.`,
    ].join('\n');

    const inserted = await insertAlert({
      userId,
      type,
      certainty: 'verified',
      message,
      evidence: {
        event_id: row.event_id,
        usd,
        asset: row.asset,
        direction: row.direction,
        counterparty,
      },
      dedupKey: `${type}:${row.event_id}`,
    });
    if (inserted) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Detector: spend_spike
// Fires when total expenses in last 24h > 2× the daily average of the prior 6 days
// (days 2–7; the last 24h is excluded from the baseline).
// Requires the user's event history to cover the full 7-day window.
// Cooldown: at most one spend_spike per user per rolling 24h.
// ---------------------------------------------------------------------------
export async function detectSpendSpike(userId: string): Promise<number> {
  const dedupKey = `spend_spike:${userId}:${new Date().toISOString()}`;

  const res = await query<{
    spend_24h: string | null;
    spend_baseline: string | null;
    provisional_24h: string | null;
    materiality_usd: string | null;
    has_history: boolean | null;
  }>(
    `SELECT
       SUM(CASE WHEN ne.block_time >= NOW() - INTERVAL '1 day'
                THEN ${USD}
                ELSE 0 END)::text AS spend_24h,
       SUM(CASE WHEN ne.block_time < NOW() - INTERVAL '1 day'
                THEN ${USD}
                ELSE 0 END)::text AS spend_baseline,
       SUM(CASE WHEN ne.block_time >= NOW() - INTERVAL '1 day' AND c.status = 'provisional'
                THEN ${USD}
                ELSE 0 END)::text AS provisional_24h,
       MAX(u.materiality_usd)::text AS materiality_usd,
       (SELECT MIN(e.block_time) <= NOW() - INTERVAL '7 days'
          FROM normalized_events e WHERE e.user_id = $1 AND e.supported IS TRUE) AS has_history
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     JOIN users u ON u.id = ne.user_id
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND c.superseded_at IS NULL
       AND c.label IN ('expense', 'x402_spend')
       AND ne.block_time >= NOW() - INTERVAL '7 days'`,
    [userId],
  );

  const row = res.rows[0];
  if (!row) return 0;

  // Too little history: the baseline window isn't covered, so any spend would look like a spike.
  if (!row.has_history) return 0;

  const spend24h = parseFloat(row.spend_24h ?? '0');
  const spendBaseline = parseFloat(row.spend_baseline ?? '0');
  const dailyAvg = spendBaseline / BASELINE_DAYS;

  // Zero baseline with full history = no spend in the prior 6 days; still gated by materiality below.
  const spikeRatio = dailyAvg > 0 ? spend24h / dailyAvg : spend24h > 0 ? Infinity : 0;
  if (spikeRatio < 2 || spend24h < parseFloat(row.materiality_usd ?? '50')) return 0;

  const context = isFinite(spikeRatio)
    ? `${spikeRatio.toFixed(1)}x your usual $${dailyAvg.toFixed(2)} a day over the previous ${BASELINE_DAYS} days`
    : `with no spending in the previous ${BASELINE_DAYS} days`;
  // Spending that includes AI-guessed labels is a suspected spike, worded as a question
  const guessed = parseFloat(row.provisional_24h ?? '0');
  const message = guessed > 0
    ? [
        `Spending looks up`,
        `By my count you spent $${spend24h.toFixed(2)} in the last 24 hours, ${context}. $${guessed.toFixed(2)} of that is labeled by my best guess; can you confirm those are expenses?`,
      ].join('\n')
    : [
        `Spending is up`,
        `You spent $${spend24h.toFixed(2)} in the last 24 hours, ${context}.`,
      ].join('\n');

  const inserted = await insertAlertWithCooldown({
    userId,
    type: 'spend_spike',
    certainty: guessed > 0 ? 'suspected' : 'verified',
    message,
    evidence: {
      spend_24h: spend24h,
      daily_avg: dailyAvg,
      // JSON has no Infinity — store null for "no baseline spend"
      spike_ratio: isFinite(spikeRatio) ? spikeRatio : null,
      baseline_days: BASELINE_DAYS,
    },
    dedupKey,
  });
  return inserted ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Detector: treasury_floor
// Fires when latest USDC snapshot on a treasury wallet < materiality_usd
// Cooldown: at most one treasury_floor per wallet per rolling 24h.
// ---------------------------------------------------------------------------
export async function detectTreasuryFloor(userId: string): Promise<number> {
  const now = new Date().toISOString();

  const res = await query<{
    wallet_id: string;
    wallet_address: string;
    wallet_label: string | null;
    balance: string;
    materiality_usd: string;
    snapshot_at: Date;
  }>(
    `SELECT DISTINCT ON (bs.wallet_id)
       w.id AS wallet_id, w.address AS wallet_address, w.label AS wallet_label,
       bs.balance::text, bs.snapshot_at,
       u.materiality_usd::text
     FROM balance_snapshots bs
     JOIN wallets w ON w.id = bs.wallet_id AND w.active = TRUE
     JOIN wallet_roles wr ON wr.wallet_id = w.id AND wr.role = 'treasury'
     JOIN users u ON u.id = bs.user_id
     WHERE bs.user_id = $1 AND bs.asset = 'USDC'
     ORDER BY bs.wallet_id, bs.snapshot_at DESC`,
    [userId],
  );

  let count = 0;
  for (const row of res.rows) {
    // A balance older than 2 hours proves nothing about now (wallet_stale covers that)
    if (Date.now() - new Date(row.snapshot_at).getTime() > 2 * 60 * 60 * 1000) continue;
    const balance = parseFloat(row.balance);
    const threshold = parseFloat(row.materiality_usd);
    if (balance >= threshold) continue;

    const dedupKey = `treasury_floor:${row.wallet_id}:${now}`;
    const walletHint = row.wallet_label
      ? `${formatAddress(row.wallet_address)} (${row.wallet_label})`
      : formatAddress(row.wallet_address);

    const message = [
      `Treasury below your floor`,
      `${walletHint} holds $${balance.toFixed(2)} USDC, under your $${threshold.toFixed(2)} threshold.`,
    ].join('\n');

    const inserted = await insertAlertWithCooldown(
      {
        userId,
        type: 'treasury_floor',
        certainty: 'verified',
        message,
        evidence: { wallet_id: row.wallet_id, balance, threshold },
        dedupKey,
      },
      { evidenceKey: 'wallet_id', value: row.wallet_id },
    );
    if (inserted) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Detector: unusual_gas
// Fires when gas spend last 24h > 5× the daily average of the prior 6 days
// (days 2–7; the last 24h is excluded from the baseline).
// Requires the user's event history to cover the full 7-day window and a non-zero baseline.
// Cooldown: at most one unusual_gas per user per rolling 24h.
// ---------------------------------------------------------------------------
export async function detectUnusualGas(userId: string): Promise<number> {
  const dedupKey = `unusual_gas:${userId}:${new Date().toISOString()}`;

  const res = await query<{
    gas_24h: string | null;
    gas_baseline: string | null;
    has_history: boolean | null;
  }>(
    `SELECT
       SUM(CASE WHEN ne.block_time >= NOW() - INTERVAL '1 day'
                THEN ${USD}
                ELSE 0 END)::text AS gas_24h,
       SUM(CASE WHEN ne.block_time < NOW() - INTERVAL '1 day'
                THEN ${USD}
                ELSE 0 END)::text AS gas_baseline,
       (SELECT MIN(e.block_time) <= NOW() - INTERVAL '7 days'
          FROM normalized_events e WHERE e.user_id = $1 AND e.supported IS TRUE) AS has_history
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND c.superseded_at IS NULL
       AND c.label = 'gas'
       AND ne.block_time >= NOW() - INTERVAL '7 days'`,
    [userId],
  );

  const row = res.rows[0];
  if (!row) return 0;

  // Too little history: the baseline window isn't covered.
  if (!row.has_history) return 0;

  const gas24h = parseFloat(row.gas_24h ?? '0');
  const gasBaseline = parseFloat(row.gas_baseline ?? '0');
  const dailyAvg = gasBaseline / BASELINE_DAYS;

  // No baseline gas → no meaningful ratio; skip rather than divide by zero.
  const spikeRatio = dailyAvg > 0 ? gas24h / dailyAvg : 0;
  if (spikeRatio < 5 || gas24h < 1) return 0; // ignore sub-$1 gas noise

  const message = [
    `Gas is unusually high`,
    `You paid $${gas24h.toFixed(2)} in gas in the last 24 hours, ${spikeRatio.toFixed(1)}x your usual $${dailyAvg.toFixed(2)} a day.`,
  ].join('\n');

  const inserted = await insertAlertWithCooldown({
    userId,
    type: 'unusual_gas',
    certainty: 'verified',
    message,
    evidence: { gas_24h: gas24h, daily_avg: dailyAvg, spike_ratio: spikeRatio, baseline_days: BASELINE_DAYS },
    dedupKey,
  });
  return inserted ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Detector: classifier_degradation
// Fires when high-confidence error rate > 5% and at least 10 high-conf classifications exist
// dedup_key: classifier_degradation:userId:YYYY-MM-DD
// ---------------------------------------------------------------------------
export async function detectClassifierDegradation(userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = `classifier_degradation:${userId}:${today}`;

  const { rate, count, total_high_confidence } = await getHighConfidenceErrorRate(userId);

  // Need meaningful sample and error rate above threshold
  if (total_high_confidence < 10 || rate < 0.05) return 0;

  const message = [
    `Classification quality dropped`,
    `${count} of ${total_high_confidence} high-confidence labels were corrected (${(rate * 100).toFixed(1)}%). Run /quality for the breakdown.`,
  ].join('\n');

  const inserted = await insertAlert({
    userId,
    type: 'classifier_degradation',
    certainty: 'data_issue',
    message,
    evidence: { error_rate: rate, error_count: count, total_high_confidence },
    dedupKey,
  });
  return inserted ? 1 : 0;
}
