import { query } from '../db.js';
import { logger } from '../logger.js';
import { getPnlSummary } from '../books/query.js';

type HeartbeatAlertType = 'portfolio_up' | 'portfolio_down' | 'pnl_positive' | 'books_attention' | 'snapshot_incomplete';
export type Certainty = 'verified' | 'suspected' | 'data_issue';

type NewAlert = {
  userId: string;
  type: HeartbeatAlertType;
  certainty: Certainty;
  message: string;
  evidence: Record<string, unknown>;
  dedupKey: string;
};

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

// Hours a day's snapshot may stay incomplete before the operator is told
const INCOMPLETE_NOTICE_HOURS = 6;

type SnapshotRow = {
  snapshot_date: string;
  total_balance_usdc: string;
  net_pnl_7d: string;
  revenue_7d: string;
  expenses_7d: string;
  unknown_count_7d: string;
  complete: boolean;
  wallet_ids: string[] | null;
  assets: string[] | null;
  incomplete_reason: string | null;
  created_at: Date;
};

function sameSet(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Why two snapshots cannot be compared, or null when they can: both complete, one day
// apart, covering the same wallets and the same assets.
export function incomparable(latest: SnapshotRow, prev: SnapshotRow | undefined): string | null {
  if (!latest.complete) return 'latest snapshot incomplete';
  if (!prev) return 'no snapshot for the day before';
  if (prev.snapshot_date !== dayBefore(latest.snapshot_date)) return 'snapshots are not on consecutive days';
  if (!prev.complete) return 'previous snapshot incomplete';
  if (!sameSet(latest.wallet_ids, prev.wallet_ids)) return 'wallet set changed';
  if (!sameSet(latest.assets, prev.assets)) return 'asset set changed';
  return null;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

// Compares the two most recent heartbeat snapshots and fires alerts on material changes.
export async function detectPortfolioChanges(userId: string): Promise<number> {
  const res = await query<SnapshotRow>(
    `SELECT snapshot_date::text, total_balance_usdc::text, net_pnl_7d::text,
            revenue_7d::text, expenses_7d::text, unknown_count_7d::text,
            complete, wallet_ids, assets, incomplete_reason, created_at
     FROM financial_heartbeat_snapshots
     WHERE user_id = $1
     ORDER BY snapshot_date DESC
     LIMIT 2`,
    [userId],
  );

  const [latest, prev] = res.rows;
  if (!latest) return 0;
  const latestDate = latest.snapshot_date;
  let fired = 0;

  // Balances could not be read completely for hours: say so, with no financial claim
  if (!latest.complete) {
    const hours = (Date.now() - new Date(latest.created_at).getTime()) / 3_600_000;
    // A row without a reason predates coverage tracking (migration 020): no notice
    if (hours >= INCOMPLETE_NOTICE_HOURS && latest.incomplete_reason) {
      const inserted = await insertAlert({
        userId,
        type: 'snapshot_incomplete',
        certainty: 'data_issue',
        message: [
          'Balance check incomplete',
          `I could not read all your balances today (${latest.incomplete_reason ?? 'data unavailable'}), so I have not compared your holdings with yesterday. Your books are unaffected; I will keep trying.`,
        ].join('\n'),
        evidence: { date: latestDate, reason: latest.incomplete_reason },
        dedupKey: `snapshot_incomplete:${userId}:${latestDate}`,
      });
      if (inserted) fired++;
    }
    return fired;
  }

  const why = incomparable(latest, prev);
  if (why) {
    logger.info({ userId, date: latestDate, why }, 'Portfolio change not evaluated: snapshots not comparable');
  } else if (prev) {
    const latestBalance = parseFloat(latest.total_balance_usdc);
    const prevBalance = parseFloat(prev.total_balance_usdc);
    const delta = latestBalance - prevBalance;
    const deltaPct = prevBalance > 0 ? Math.abs(delta) / prevBalance : 0;
    const evidence = { delta, delta_pct: deltaPct, latest_balance: latestBalance, prev_balance: prevBalance, date: latestDate, prev_date: prev.snapshot_date };

    // Portfolio up: delta >= $200 or >= 10%
    if (delta >= 200 || (delta > 0 && deltaPct >= 0.1)) {
      const inserted = await insertAlert({
        userId,
        type: 'portfolio_up',
        certainty: 'verified',
        message: `Your holdings are up $${fmt(delta)} (+${(deltaPct * 100).toFixed(1)}%) since yesterday, now $${fmt(latestBalance)}.`,
        evidence,
        dedupKey: `portfolio_up:${userId}:${latestDate}`,
      });
      if (inserted) fired++;
    }

    // Portfolio down: delta <= -$200 or >= 10% drop
    if (delta <= -200 || (delta < 0 && deltaPct >= 0.1)) {
      const inserted = await insertAlert({
        userId,
        type: 'portfolio_down',
        certainty: 'verified',
        message: `Your holdings are down $${fmt(Math.abs(delta))} (-${(deltaPct * 100).toFixed(1)}%) since yesterday, now $${fmt(latestBalance)}.`,
        evidence,
        dedupKey: `portfolio_down:${userId}:${latestDate}`,
      });
      if (inserted) fired++;
    }
  }

  // Positive P&L: net_pnl_7d >= $100 — weekly dedup (ISO week)
  const netPnl7d = parseFloat(latest.net_pnl_7d);
  if (netPnl7d >= 100) {
    // Use ISO week number for dedup so it fires at most once per calendar week
    const d = new Date(latestDate);
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const week = Math.ceil(((d.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7);
    const weekKey = `${d.getFullYear()}-W${week}`;

    // Revenue that is partly the AI's guess makes this a suspected, not a verified, result
    const pnl = await getPnlSummary(userId, 7);
    const guessed = pnl.revenue_provisional_usdc > 0;
    const inserted = await insertAlert({
      userId,
      type: 'pnl_positive',
      certainty: guessed ? 'suspected' : 'verified',
      message: `A positive week${guessed ? ' by my count' : ''}: net $${fmt(netPnl7d)}, from $${fmt(parseFloat(latest.revenue_7d))} revenue and $${fmt(parseFloat(latest.expenses_7d))} expenses.${guessed ? ` $${fmt(pnl.revenue_provisional_usdc)} of that revenue is my best guess; confirm it and I will firm this up.` : ''}`,
      evidence: { net_pnl_7d: netPnl7d, revenue_7d: parseFloat(latest.revenue_7d), expenses_7d: parseFloat(latest.expenses_7d), date: latestDate },
      dedupKey: `pnl_positive:${userId}:${weekKey}`,
    });
    if (inserted) fired++;
  }

  // Books attention: unknown_count_7d > 10% of total recent events — daily dedup
  const unknownCount = parseInt(latest.unknown_count_7d);
  if (unknownCount > 10) {
    const inserted = await insertAlert({
      userId,
      type: 'books_attention',
      certainty: 'verified',
      message: `${unknownCount} transfers this week still need context. Tell me what they were and I will keep your books accurate.`,
      evidence: { unknown_count_7d: unknownCount, date: latestDate },
      dedupKey: `books_attention:${userId}:${latestDate}`,
    });
    if (inserted) fired++;
  }

  return fired;
}
