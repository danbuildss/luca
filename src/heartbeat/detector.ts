import { query } from '../db.js';

type HeartbeatAlertType = 'books_attention';
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

// Overnight alerts that compared holdings day over day are gone (Oct 4): holdings left out
// staked tokens, so a stake read as a loss ("down 73.7%" at 01:00), and every real transfer
// already has its own alert, which left only price moves. Holdings and why they changed
// belong in the morning brief. The snapshots are still taken daily; incomparable() above
// says when two of them can be compared.
//
// What is left: transfers still waiting for context this week.
export async function detectBooksAttention(userId: string): Promise<number> {
  const latest = (await query<{ snapshot_date: string; unknown_count_7d: string }>(
    `SELECT snapshot_date::text, unknown_count_7d::text
     FROM financial_heartbeat_snapshots
     WHERE user_id = $1
     ORDER BY snapshot_date DESC
     LIMIT 1`,
    [userId],
  )).rows[0];
  if (!latest) return 0;

  // Books attention: more than 10 transfers this week still unknown — daily dedup
  const unknownCount = parseInt(latest.unknown_count_7d);
  if (unknownCount > 10) {
    const inserted = await insertAlert({
      userId,
      type: 'books_attention',
      certainty: 'verified',
      message: `${unknownCount} transfers this week still need context. Tell me what they were and I will keep your books accurate.`,
      evidence: { unknown_count_7d: unknownCount, date: latest.snapshot_date },
      dedupKey: `books_attention:${userId}:${latest.snapshot_date}`,
    });
    if (inserted) return 1;
  }
  return 0;
}
