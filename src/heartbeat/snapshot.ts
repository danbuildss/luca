import { query } from '../db.js';
import { getPnlSummary } from '../books/query.js';
import { logger } from '../logger.js';

export async function takeHeartbeatSnapshot(userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  // Check if we already have a snapshot for today (idempotent)
  const existing = await query<{ id: string }>(
    `SELECT id FROM financial_heartbeat_snapshots WHERE user_id = $1 AND snapshot_date = $2`,
    [userId, today],
  );
  if (existing.rows.length > 0) return;

  // Sum most recent balances per wallet/asset across all active wallets
  const balanceRes = await query<{ total_usdc: string | null }>(
    `SELECT SUM(
       CASE WHEN bs.asset = 'USDC' THEN bs.balance
            WHEN bs.asset = 'ETH'  THEN bs.balance * COALESCE(
              (SELECT usd_value / amount
               FROM normalized_events
               WHERE user_id = $1 AND asset = 'ETH' AND usd_value IS NOT NULL AND amount > 0
               ORDER BY block_time DESC LIMIT 1), 0)
            ELSE 0
       END
     )::text AS total_usdc
     FROM balance_snapshots bs
     JOIN wallets w ON w.id = bs.wallet_id AND w.user_id = $1
     WHERE bs.snapshot_at = (
       SELECT MAX(bs2.snapshot_at) FROM balance_snapshots bs2 WHERE bs2.wallet_id = bs.wallet_id AND bs2.asset = bs.asset
     )`,
    [userId],
  );

  const totalBalanceUsdc = parseFloat(balanceRes.rows[0]?.total_usdc ?? '0') || 0;

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
