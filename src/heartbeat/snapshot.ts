import { query } from '../db.js';
import { getPnlSummary } from '../books/query.js';
import { getValuedBalances } from '../books/balances.js';
import { logger } from '../logger.js';

// Assets every snapshot must cover, per active wallet
export const SNAPSHOT_ASSETS = ['BNKR', 'ETH', 'USDC'] as const;
// Balances older than this make a snapshot incomplete
export const MAX_BALANCE_AGE_MS = 2 * 60 * 60 * 1000;

export type SnapshotCoverage = {
  complete: boolean;
  wallet_ids: string[];
  assets: string[];
  oldest_balance_at: Date | null;
  reasons: string[];
};

// What today's total would cover, and whether it can be trusted: every active wallet read
// successfully, recently, for every asset, and every needed price available.
export async function snapshotCoverage(userId: string, totalIncomplete: boolean, now = new Date()): Promise<SnapshotCoverage> {
  const wallets = await query<{ id: string; address: string; status: string | null }>(
    `SELECT w.id, w.address, wj.status
     FROM wallets w LEFT JOIN watch_jobs wj ON wj.wallet_id = w.id
     WHERE w.user_id = $1 AND w.active = TRUE
     ORDER BY w.id`,
    [userId],
  );
  const latest = await query<{ wallet_id: string; asset: string; snapshot_at: Date }>(
    `SELECT DISTINCT ON (bs.wallet_id, bs.asset) bs.wallet_id, bs.asset, bs.snapshot_at
     FROM balance_snapshots bs
     JOIN wallets w ON w.id = bs.wallet_id AND w.user_id = $1 AND w.active = TRUE
     WHERE bs.asset = ANY($2::text[])
     ORDER BY bs.wallet_id, bs.asset, bs.snapshot_at DESC`,
    [userId, [...SNAPSHOT_ASSETS]],
  );

  const reasons: string[] = [];
  if (wallets.rows.length === 0) reasons.push('no active wallets');
  let oldest: Date | null = null;
  for (const w of wallets.rows) {
    if (w.status === 'error') reasons.push(`last sync of ${w.address} failed`);
    for (const asset of SNAPSHOT_ASSETS) {
      const row = latest.rows.find((r) => r.wallet_id === w.id && r.asset === asset);
      if (!row) { reasons.push(`no ${asset} balance for ${w.address}`); continue; }
      const at = new Date(row.snapshot_at);
      if (!oldest || at < oldest) oldest = at;
      if (now.getTime() - at.getTime() > MAX_BALANCE_AGE_MS) reasons.push(`${asset} balance for ${w.address} is out of date`);
    }
  }
  if (totalIncomplete) reasons.push('a live price is unavailable');

  return {
    complete: reasons.length === 0,
    wallet_ids: wallets.rows.map((w) => w.id),
    assets: [...SNAPSHOT_ASSETS],
    oldest_balance_at: oldest,
    reasons: [...new Set(reasons)],
  };
}

// Once a day per operator. An incomplete snapshot is stored (so the gap is visible) and
// retried every cycle until it is complete; a complete one is final for the day.
export async function takeHeartbeatSnapshot(userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  const existing = await query<{ complete: boolean }>(
    `SELECT complete FROM financial_heartbeat_snapshots WHERE user_id = $1 AND snapshot_date = $2`,
    [userId, today],
  );
  if (existing.rows[0]?.complete) return;

  const valued = await getValuedBalances(userId);
  const coverage = await snapshotCoverage(userId, valued.total_incomplete);
  const pnl = await getPnlSummary(userId, 7);

  await query(
    `INSERT INTO financial_heartbeat_snapshots
       (user_id, snapshot_date, total_balance_usdc, net_pnl_7d, revenue_7d, expenses_7d, unknown_count_7d,
        complete, wallet_ids, assets, prices, oldest_balance_at, incomplete_reason, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (user_id, snapshot_date) DO UPDATE
       SET total_balance_usdc = EXCLUDED.total_balance_usdc, net_pnl_7d = EXCLUDED.net_pnl_7d,
           revenue_7d = EXCLUDED.revenue_7d, expenses_7d = EXCLUDED.expenses_7d,
           unknown_count_7d = EXCLUDED.unknown_count_7d, complete = EXCLUDED.complete,
           wallet_ids = EXCLUDED.wallet_ids, assets = EXCLUDED.assets, prices = EXCLUDED.prices,
           oldest_balance_at = EXCLUDED.oldest_balance_at, incomplete_reason = EXCLUDED.incomplete_reason,
           updated_at = NOW()
       WHERE financial_heartbeat_snapshots.complete = FALSE`,
    [
      userId, today, valued.total_usd, pnl.net_usdc, pnl.revenue_usdc, pnl.expenses_usdc, pnl.unknown_count,
      coverage.complete, coverage.wallet_ids, coverage.assets, JSON.stringify(valued.prices),
      coverage.oldest_balance_at, coverage.complete ? null : coverage.reasons.join('; '),
    ],
  );

  if (!coverage.complete) {
    logger.warn({ userId, reasons: coverage.reasons }, 'Heartbeat snapshot incomplete; retrying next cycle');
  }
}
