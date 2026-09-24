import { query } from '../db.js';
import { getPnlSummary } from '../books/query.js';
import { getValuedBalances } from '../books/balances.js';
import { logger } from '../logger.js';

export async function takeHeartbeatSnapshot(userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  // Check if we already have a snapshot for today (idempotent)
  const existing = await query<{ id: string }>(
    `SELECT id FROM financial_heartbeat_snapshots WHERE user_id = $1 AND snapshot_date = $2`,
    [userId, today],
  );
  if (existing.rows.length > 0) return;

  // A missing live price would understate the total and fire a false 'portfolio down'
  // alert, so skip today's snapshot; the next worker cycle retries.
  const valued = await getValuedBalances(userId);
  if (valued.total_incomplete) {
    logger.warn({ userId }, 'Heartbeat snapshot deferred — live price unavailable');
    return;
  }
  const totalBalanceUsdc = valued.total_usd;

  const pnl = await getPnlSummary(userId, 7);

  await query(
    `INSERT INTO financial_heartbeat_snapshots
       (user_id, snapshot_date, total_balance_usdc, net_pnl_7d, revenue_7d, expenses_7d, unknown_count_7d)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, snapshot_date) DO NOTHING`,
    [
      userId, today,
      totalBalanceUsdc,
      pnl.net_usdc,
      pnl.revenue_usdc,
      pnl.expenses_usdc,
      pnl.unknown_count,
    ],
  );

  logger.debug({ userId, date: today, totalBalanceUsdc, netPnl7d: pnl.net_usdc }, 'Heartbeat snapshot taken');
}
