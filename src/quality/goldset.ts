import { query } from '../db.js';

export type GoldSetCandidate = {
  event_id: string;
  block_time: Date;
  direction: 'in' | 'out';
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: number | null;
  current_label: string;
  current_confidence: number | null;
  current_method: string | null;
  hash: string | null;
};

export async function getNextForGoldSet(userId: string): Promise<GoldSetCandidate | null> {
  const res = await query<GoldSetCandidate>(
    `SELECT
       ne.id          AS event_id,
       ne.block_time,
       ne.direction,
       ne.from_address,
       ne.to_address,
       ne.asset,
       ne.amount,
       c.label        AS current_label,
       c.confidence   AS current_confidence,
       c.method       AS current_method,
       ne.hash
     FROM normalized_events ne
     JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1
       AND c.label != 'unknown'
       AND NOT EXISTS (
         SELECT 1 FROM gold_transactions gt
         WHERE gt.event_id = ne.id AND gt.user_id = $1
       )
     ORDER BY ne.block_time DESC
     LIMIT 1`,
    [userId],
  );
  return res.rows[0] ?? null;
}

export async function addGoldTransaction(
  userId: string,
  eventId: string,
  correctLabel: string,
  notes?: string,
): Promise<void> {
  await query(
    `INSERT INTO gold_transactions (user_id, event_id, correct_label, notes, added_by)
     VALUES ($1, $2, $3, $4, 'user')
     ON CONFLICT (user_id, event_id) DO UPDATE
       SET correct_label = EXCLUDED.correct_label,
           notes         = COALESCE(EXCLUDED.notes, gold_transactions.notes)`,
    [userId, eventId, correctLabel, notes ?? null],
  );
}

export async function getGoldSetCount(userId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM gold_transactions WHERE user_id = $1`,
    [userId],
  );
  return parseInt(res.rows[0]?.count ?? '0');
}
