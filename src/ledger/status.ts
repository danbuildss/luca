import { query } from '../db.js';

export type WalletLedger = {
  address: string;
  label: string | null;
  status: 'complete' | 'incomplete' | 'unknown';
  incomplete_since_at: Date | null;
  incomplete_since_block: string | null;
  last_checked_at: Date | null;
};

export type LedgerStatus = {
  // complete: every wallet's books were proven against the chain at the last check;
  // incomplete: at least one wallet has an unexplained balance change;
  // checking: not every wallet has been checked yet.
  status: 'complete' | 'incomplete' | 'checking';
  wallets: WalletLedger[];
};

export async function getLedgerStatus(userId: string): Promise<LedgerStatus> {
  const res = await query<WalletLedger>(
    `SELECT w.address, w.label,
            COALESCE(wj.ledger_status, 'unknown') AS status,
            wj.incomplete_since_at,
            wj.incomplete_since_block::text AS incomplete_since_block,
            wj.last_reconciled_at AS last_checked_at
     FROM wallets w
     JOIN watch_jobs wj ON wj.wallet_id = w.id
     WHERE w.user_id = $1 AND w.active = TRUE
     ORDER BY w.created_at`,
    [userId],
  );
  const wallets = res.rows;
  const status = wallets.some((w) => w.status === 'incomplete')
    ? 'incomplete'
    : wallets.length > 0 && wallets.every((w) => w.status === 'complete')
      ? 'complete'
      : 'checking';
  return { status, wallets };
}

export type LedgerHealth = {
  complete: number;
  incomplete: number;
  unchecked: number;
  repairs_7d: number;
  log_gaps_7d: number;
  degraded_pending: number;
  incomplete_wallets: Array<{ username: string | null; address: string; since_at: Date | null; since_block: string | null }>;
};

// System-wide view for the admin ops console.
export async function getLedgerHealth(): Promise<LedgerHealth> {
  const [counts, repairs, gaps, degraded, incomplete] = await Promise.all([
    query<{ complete: number; incomplete: number; unchecked: number }>(
      `SELECT COUNT(*) FILTER (WHERE wj.ledger_status = 'complete')::int AS complete,
              COUNT(*) FILTER (WHERE wj.ledger_status = 'incomplete')::int AS incomplete,
              COUNT(*) FILTER (WHERE wj.ledger_status = 'unknown')::int AS unchecked
       FROM watch_jobs wj JOIN wallets w ON w.id = wj.wallet_id
       WHERE w.active = TRUE`,
    ),
    query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM reconciliation_runs
       WHERE status = 'repaired' AND created_at >= NOW() - INTERVAL '7 days'`,
    ),
    query<{ n: number }>(
      `SELECT COALESCE(SUM(log_gaps), 0)::int AS n FROM sync_runs
       WHERE started_at >= NOW() - INTERVAL '7 days'`,
    ),
    query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sync_runs WHERE degraded AND rescanned_at IS NULL`,
    ),
    query<{ username: string | null; address: string; since_at: Date | null; since_block: string | null }>(
      `SELECT u.telegram_username AS username, w.address,
              wj.incomplete_since_at AS since_at, wj.incomplete_since_block::text AS since_block
       FROM watch_jobs wj
       JOIN wallets w ON w.id = wj.wallet_id
       JOIN users u ON u.id = wj.user_id
       WHERE w.active = TRUE AND wj.ledger_status = 'incomplete'
       ORDER BY wj.incomplete_since_at ASC NULLS LAST`,
    ),
  ]);
  const c = counts.rows[0];
  return {
    complete: c?.complete ?? 0,
    incomplete: c?.incomplete ?? 0,
    unchecked: c?.unchecked ?? 0,
    repairs_7d: repairs.rows[0]?.n ?? 0,
    log_gaps_7d: gaps.rows[0]?.n ?? 0,
    degraded_pending: degraded.rows[0]?.n ?? 0,
    incomplete_wallets: incomplete.rows,
  };
}
