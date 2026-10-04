import { query } from '../db.js';
import { usdValueSql } from '../ingestion/assets.js';
import { formatAddress } from '../telegram/format.js';
import { getHighConfidenceErrorRate } from '../quality/metrics.js';
import { txLink } from '../ledger/links.js';
import { adminUserIds, ownerWords } from '../health/detectors.js';
import { namesFor, ownWalletName } from '../books/names.js';
import { markAskedByAlert } from './questions.js';

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
// One alert per transaction whose movements reach materiality_usd, for transactions in
// the last 24h only. Not for what the operator did with their own money, which moved
// nothing to anyone else: swaps, staking and unstaking, transfers between their own
// wallets. Gas and x402 have alerts of their own.
// ---------------------------------------------------------------------------

// Labels that never make a large inflow/outflow alert
const NOT_LARGE_MOVEMENTS = ['gas', 'internal_transfer', 'x402_income', 'x402_spend', 'swap', 'staked', 'unstaked'];

// "$1,175.57"
export function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "Oct 3, 23:14" in the operator's timezone
export function whenText(d: Date, timezone: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  try { return new Date(d).toLocaleString('en-US', { ...opts, timeZone: timezone }); }
  catch { return new Date(d).toLocaleString('en-US', { ...opts, timeZone: 'UTC' }); }
}

type MovementRow = {
  event_id: string;
  hash: string;
  direction: 'in' | 'out';
  asset: string | null;
  usd: string;
  from_address: string;
  to_address: string | null;
  block_time: Date;
  wallet_label: string | null;
  wallet_address: string;
  timezone: string;
  label: string;
};

export async function detectLargeMovements(userId: string): Promise<number> {
  const res = await query<MovementRow>(
    `SELECT
       ne.id AS event_id, ne.hash, ne.direction, ne.asset, (${USD})::text AS usd,
       ne.from_address, ne.to_address, ne.block_time,
       w.label AS wallet_label, w.address AS wallet_address, u.timezone, c.label::text AS label
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     JOIN wallets w ON w.id = ne.wallet_id
     JOIN users u ON u.id = ne.user_id
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND c.superseded_at IS NULL
       AND c.label::text <> ALL($2::text[])
       AND c.shape IS DISTINCT FROM 'swap'
       AND ne.block_time >= NOW() - INTERVAL '${LARGE_MOVEMENT_WINDOW}'
       AND ${USD} IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM alerts a
         WHERE a.dedup_key IN (
           'large_inflow:' || ne.id::text,
           'large_outflow:' || ne.id::text,
           'large_movement:' || $1::text || ':' || ne.hash
         )
       )
     ORDER BY ne.block_time, ne.hash, ne.id`,
    [userId, NOT_LARGE_MOVEMENTS],
  );
  const materiality = parseFloat((await query<{ m: string }>(
    `SELECT materiality_usd::text AS m FROM users WHERE id = $1`, [userId],
  )).rows[0]?.m ?? 'NaN');
  if (!Number.isFinite(materiality)) return 0;

  // One transaction, one alert
  const byTx = new Map<string, MovementRow[]>();
  for (const row of res.rows) byTx.set(row.hash, [...(byTx.get(row.hash) ?? []), row]);

  const name = byTx.size > 0 ? await namesFor(userId) : null;
  let count = 0;
  for (const [hash, rows] of byTx) {
    const usdIn = rows.filter((r) => r.direction === 'in').reduce((t, r) => t + parseFloat(r.usd), 0);
    const usdOut = rows.filter((r) => r.direction === 'out').reduce((t, r) => t + parseFloat(r.usd), 0);
    const direction: 'in' | 'out' = usdIn >= usdOut ? 'in' : 'out';
    const total = direction === 'in' ? usdIn : usdOut;
    if (total < materiality) continue;

    const legs = rows.filter((r) => r.direction === direction);
    const first = legs[0];
    const type: AlertType = direction === 'in' ? 'large_inflow' : 'large_outflow';
    const counterparties = [...new Set(legs.map((r) => (direction === 'in' ? r.from_address : r.to_address ?? '')))];
    const assets = [...new Set(legs.map((r) => r.asset ?? 'tokens'))];
    const who = counterparties.length === 1 && counterparties[0] ? name!(counterparties[0], direction) : `${counterparties.length} addresses`;
    const walletHint = ownWalletName(first.wallet_label, first.wallet_address);
    const verb = direction === 'in' ? 'came in from' : 'went out to';
    // Not placed yet: the alert asks itself, and the morning message will not ask again
    const asks = legs.every((r) => r.label === 'unknown');

    const message = [
      type === 'large_inflow' ? 'Large inflow' : 'Large outflow',
      `${money(total)} in ${assets.join(' and ')} ${verb} ${who}, on ${walletHint}, ${whenText(first.block_time, first.timezone)}.`,
      // Tappable on BaseScan when delivered (src/telegram/format.ts)
      `Transaction: ${txLink(hash)}`,
      ...(asks ? ['', 'What was it for?'] : []),
    ].join('\n');

    const inserted = await insertAlert({
      userId,
      type,
      certainty: 'verified',
      message,
      evidence: {
        event_ids: legs.map((r) => r.event_id),
        hash,
        usd: total,
        assets,
        direction,
        counterparties,
        asks,
      },
      dedupKey: `large_movement:${userId}:${hash}`,
    });
    if (inserted) {
      count++;
      if (asks) for (const cp of counterparties) if (cp) await markAskedByAlert(userId, cp, direction);
    }
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
    ? `${spikeRatio.toFixed(1)}x your usual ${money(dailyAvg)} a day over the previous ${BASELINE_DAYS} days`
    : `with no spending in the previous ${BASELINE_DAYS} days`;
  // Spending that includes AI-guessed labels is a suspected spike, worded as a question
  const guessed = parseFloat(row.provisional_24h ?? '0');
  const message = guessed > 0
    ? [
        `Spending looks up`,
        `By my count you spent ${money(spend24h)} in the last 24 hours, ${context}. ${money(guessed)} of that is labeled by my best guess; can you confirm those are expenses?`,
      ].join('\n')
    : [
        `Spending is up`,
        `You spent ${money(spend24h)} in the last 24 hours, ${context}.`,
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
      `${walletHint} holds ${money(balance)} USDC, under your ${money(threshold)} threshold.`,
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
    `You paid ${money(gas24h)} in gas in the last 24 hours, ${spikeRatio.toFixed(1)}x your usual ${money(dailyAvg)} a day.`,
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
// dedup_key: classifier_degradation:adminId:userId:YYYY-MM-DD
// ---------------------------------------------------------------------------
export async function detectClassifierDegradation(userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { rate, count, total_high_confidence } = await getHighConfidenceErrorRate(userId);

  // Need meaningful sample and error rate above threshold
  if (total_high_confidence < 10 || rate < 0.05) return 0;

  // About Luca's labeling, not the operator's money: told to admins only, naming whose books
  let fired = 0;
  for (const adminId of await adminUserIds()) {
    const owner = await ownerWords(userId, adminId);
    const message = [
      `Classification quality dropped`,
      `${owner} books: ${count} of ${total_high_confidence} high-confidence labels were corrected (${(rate * 100).toFixed(1)}%). Run /quality for the breakdown.`,
    ].join('\n');
    const inserted = await insertAlert({
      userId: adminId,
      type: 'classifier_degradation',
      certainty: 'data_issue',
      message,
      evidence: { owner_user_id: userId, error_rate: rate, error_count: count, total_high_confidence },
      dedupKey: `classifier_degradation:${adminId}:${userId}:${today}`,
    });
    if (inserted) fired++;
  }
  return fired;
}
