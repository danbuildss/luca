import { query } from '../db.js';
import { formatAddress } from '../telegram/format.js';
import { logger } from '../logger.js';

type AlertType =
  | 'large_inflow'
  | 'large_outflow'
  | 'spend_spike'
  | 'treasury_floor'
  | 'unusual_gas';

type NewAlert = {
  userId: string;
  type: AlertType;
  message: string;
  evidence: Record<string, unknown>;
  dedupKey: string;
};

// Returns true when a new alert row was inserted (false = dedup hit, already exists)
async function insertAlert(alert: NewAlert): Promise<boolean> {
  const res = await query<{ id: string }>(
    `INSERT INTO alerts (user_id, type, message, evidence, dedup_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [alert.userId, alert.type, alert.message, JSON.stringify(alert.evidence), alert.dedupKey],
  );
  return res.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Detector: large_inflow / large_outflow
// Fires once per event where usd_value (or USDC amount) >= materiality_usd
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
       AND c.superseded_at IS NULL
       AND c.label NOT IN ('gas', 'internal_transfer')
       AND COALESCE(ne.usd_value, CASE WHEN ne.asset = 'USDC' THEN ne.amount ELSE NULL END)
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
    const icon = row.direction === 'in' ? '💰' : '🔴';
    const verb = row.direction === 'in' ? 'received from' : 'sent to';
    const counterparty = row.direction === 'in'
      ? formatAddress(row.from_address)
      : row.to_address ? formatAddress(row.to_address) : '—';
    const walletHint = row.wallet_label
      ? `${formatAddress(row.wallet_address)} (${row.wallet_label})`
      : formatAddress(row.wallet_address);

    const message = [
      `${icon} ${type === 'large_inflow' ? 'Large inflow' : 'Large outflow'}`,
      `$${usd.toFixed(2)} ${row.asset ?? ''} ${verb} ${counterparty}`,
      `Wallet: ${walletHint}`,
    ].join('\n');

    const inserted = await insertAlert({
      userId,
      type,
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
// Fires when total expenses in last 24h > 2× 7-day daily average
// dedup_key: spend_spike:userId:YYYY-MM-DD  (one per day)
// ---------------------------------------------------------------------------
export async function detectSpendSpike(userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = `spend_spike:${userId}:${today}`;

  const res = await query<{
    spend_24h: string | null;
    spend_7d: string | null;
    materiality_usd: string;
  }>(
    `SELECT
       SUM(CASE WHEN ne.block_time >= NOW() - INTERVAL '1 day'
                THEN COALESCE(ne.usd_value, CASE WHEN ne.asset = 'USDC' THEN ne.amount ELSE 0 END)
                ELSE 0 END)::text AS spend_24h,
       SUM(COALESCE(ne.usd_value, CASE WHEN ne.asset = 'USDC' THEN ne.amount ELSE 0 END))::text AS spend_7d,
       MAX(u.materiality_usd)::text AS materiality_usd
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     JOIN users u ON u.id = ne.user_id
     WHERE ne.user_id = $1
       AND c.superseded_at IS NULL
       AND c.label IN ('expense', 'x402_spend')
       AND ne.block_time >= NOW() - INTERVAL '7 days'`,
    [userId],
  );

  const row = res.rows[0];
  if (!row) return 0;

  const spend24h = parseFloat(row.spend_24h ?? '0');
  const spend7d = parseFloat(row.spend_7d ?? '0');
  const dailyAvg = spend7d / 7;

  // Need at least some baseline and the spike must be meaningful
  const spikeRatio = dailyAvg > 0 ? spend24h / dailyAvg : spend24h > 0 ? Infinity : 0;
  if (spikeRatio < 2 || spend24h < parseFloat(row.materiality_usd ?? '50')) return 0;

  const ratioStr = isFinite(spikeRatio) ? `${spikeRatio.toFixed(1)}×` : 'first spend day';
  const message = [
    `⚠️ Spend spike`,
    `$${spend24h.toFixed(2)} spent today (${ratioStr} your 7-day avg of $${dailyAvg.toFixed(2)}/day)`,
  ].join('\n');

  const inserted = await insertAlert({
    userId,
    type: 'spend_spike',
    message,
    evidence: { spend_24h: spend24h, daily_avg: dailyAvg, spike_ratio: spikeRatio },
    dedupKey,
  });
  return inserted ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Detector: treasury_floor
// Fires when latest USDC snapshot on a treasury wallet < materiality_usd
// dedup_key: treasury_floor:walletId:YYYY-MM-DD
// ---------------------------------------------------------------------------
export async function detectTreasuryFloor(userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);

  const res = await query<{
    wallet_id: string;
    wallet_address: string;
    wallet_label: string | null;
    balance: string;
    materiality_usd: string;
  }>(
    `SELECT DISTINCT ON (bs.wallet_id)
       w.id AS wallet_id, w.address AS wallet_address, w.label AS wallet_label,
       bs.balance::text,
       u.materiality_usd::text
     FROM balance_snapshots bs
     JOIN wallets w ON w.id = bs.wallet_id
     JOIN wallet_roles wr ON wr.wallet_id = w.id AND wr.role = 'treasury'
     JOIN users u ON u.id = bs.user_id
     WHERE bs.user_id = $1 AND bs.asset = 'USDC'
     ORDER BY bs.wallet_id, bs.snapshot_at DESC`,
    [userId],
  );

  let count = 0;
  for (const row of res.rows) {
    const balance = parseFloat(row.balance);
    const threshold = parseFloat(row.materiality_usd);
    if (balance >= threshold) continue;

    const dedupKey = `treasury_floor:${row.wallet_id}:${today}`;
    const walletHint = row.wallet_label
      ? `${formatAddress(row.wallet_address)} (${row.wallet_label})`
      : formatAddress(row.wallet_address);

    const message = [
      `⚠️ Treasury floor`,
      `${walletHint} balance: $${balance.toFixed(2)} USDC`,
      `Below your $${threshold.toFixed(2)} threshold`,
    ].join('\n');

    const inserted = await insertAlert({
      userId,
      type: 'treasury_floor',
      message,
      evidence: { wallet_id: row.wallet_id, balance, threshold },
      dedupKey,
    });
    if (inserted) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Detector: unusual_gas
// Fires when gas spend last 24h > 5× 7-day daily average
// dedup_key: unusual_gas:userId:YYYY-MM-DD
// ---------------------------------------------------------------------------
export async function detectUnusualGas(userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = `unusual_gas:${userId}:${today}`;

  const res = await query<{
    gas_24h: string | null;
    gas_7d: string | null;
  }>(
    `SELECT
       SUM(CASE WHEN ne.block_time >= NOW() - INTERVAL '1 day'
                THEN COALESCE(ne.usd_value, CASE WHEN ne.asset = 'ETH' THEN ne.amount * 3000 ELSE 0 END)
                ELSE 0 END)::text AS gas_24h,
       SUM(COALESCE(ne.usd_value, CASE WHEN ne.asset = 'ETH' THEN ne.amount * 3000 ELSE 0 END))::text AS gas_7d
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     WHERE ne.user_id = $1
       AND c.superseded_at IS NULL
       AND c.label = 'gas'
       AND ne.block_time >= NOW() - INTERVAL '7 days'`,
    [userId],
  );

  const row = res.rows[0];
  if (!row) return 0;

  const gas24h = parseFloat(row.gas_24h ?? '0');
  const gas7d = parseFloat(row.gas_7d ?? '0');
  const dailyAvg = gas7d / 7;

  const spikeRatio = dailyAvg > 0 ? gas24h / dailyAvg : 0;
  if (spikeRatio < 5 || gas24h < 1) return 0; // ignore sub-$1 gas noise

  const message = [
    `⛽ Unusual gas`,
    `$${gas24h.toFixed(2)} in gas today (${spikeRatio.toFixed(1)}× your 7-day avg of $${dailyAvg.toFixed(2)}/day)`,
  ].join('\n');

  const inserted = await insertAlert({
    userId,
    type: 'unusual_gas',
    message,
    evidence: { gas_24h: gas24h, daily_avg: dailyAvg, spike_ratio: spikeRatio },
    dedupKey,
  });
  return inserted ? 1 : 0;
}
