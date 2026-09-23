import { query } from '../db.js';

type HeartbeatAlertType = 'portfolio_up' | 'portfolio_down' | 'pnl_positive' | 'books_attention';

type NewAlert = {
  userId: string;
  type: HeartbeatAlertType;
  message: string;
  evidence: Record<string, unknown>;
  dedupKey: string;
};

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

function fmt(n: number): string {
  return n.toFixed(2);
}

// Compares the two most recent heartbeat snapshots and fires alerts on material changes.
export async function detectPortfolioChanges(userId: string): Promise<number> {
  const res = await query<{
    snapshot_date: string;
    total_balance_usdc: string;
    net_pnl_7d: string;
    revenue_7d: string;
    expenses_7d: string;
    unknown_count_7d: string;
  }>(
    `SELECT snapshot_date::text, total_balance_usdc::text, net_pnl_7d::text,
            revenue_7d::text, expenses_7d::text, unknown_count_7d::text
     FROM financial_heartbeat_snapshots
     WHERE user_id = $1
     ORDER BY snapshot_date DESC
     LIMIT 2`,
    [userId],
  );

  if (res.rows.length < 2) return 0; // need at least two snapshots to compare

  const [latest, prev] = res.rows;
  const latestBalance = parseFloat(latest.total_balance_usdc);
  const prevBalance = parseFloat(prev.total_balance_usdc);
  const delta = latestBalance - prevBalance;
  const deltaPct = prevBalance > 0 ? Math.abs(delta) / prevBalance : 0;
  const latestDate = latest.snapshot_date;

  let fired = 0;

  // Portfolio up: delta >= $200 or >= 10%
  if (delta >= 200 || (delta > 0 && deltaPct >= 0.1)) {
    const inserted = await insertAlert({
      userId,
      type: 'portfolio_up',
      message: `💹 Portfolio up $${fmt(delta)} (+${(deltaPct * 100).toFixed(1)}%) — balance now $${fmt(latestBalance)}`,
      evidence: { delta, delta_pct: deltaPct, latest_balance: latestBalance, prev_balance: prevBalance, date: latestDate },
      dedupKey: `portfolio_up:${userId}:${latestDate}`,
    });
    if (inserted) fired++;
  }

  // Portfolio down: delta <= -$200 or >= 10% drop
  if (delta <= -200 || (delta < 0 && deltaPct >= 0.1)) {
    const inserted = await insertAlert({
      userId,
      type: 'portfolio_down',
      message: `📉 Portfolio down $${fmt(Math.abs(delta))} (-${(deltaPct * 100).toFixed(1)}%) — balance now $${fmt(latestBalance)}`,
      evidence: { delta, delta_pct: deltaPct, latest_balance: latestBalance, prev_balance: prevBalance, date: latestDate },
      dedupKey: `portfolio_down:${userId}:${latestDate}`,
    });
    if (inserted) fired++;
  }

  // Positive P&L: net_pnl_7d >= $100 — weekly dedup (ISO week)
  const netPnl7d = parseFloat(latest.net_pnl_7d);
  if (netPnl7d >= 100) {
    // Use ISO week number for dedup so it fires at most once per calendar week
    const d = new Date(latestDate);
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const week = Math.ceil(((d.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7);
    const weekKey = `${d.getFullYear()}-W${week}`;

    const inserted = await insertAlert({
      userId,
      type: 'pnl_positive',
      message: `✅ Positive week: $${fmt(netPnl7d)} net P&L — revenue $${fmt(parseFloat(latest.revenue_7d))}, expenses $${fmt(parseFloat(latest.expenses_7d))}`,
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
      message: `📋 Books need attention: ${unknownCount} unclassified transactions this week — label them to keep your P&L accurate`,
      evidence: { unknown_count_7d: unknownCount, date: latestDate },
      dedupKey: `books_attention:${userId}:${latestDate}`,
    });
    if (inserted) fired++;
  }

  return fired;
}
