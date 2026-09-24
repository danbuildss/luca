import { query } from '../db.js';

// Per-counterparty questions sent before grouped questions (src/alerts/questions.ts).
// Kept so the buttons on messages already sent still work.

export type CounterpartyAlert = {
  id: string;
  counterparty_address: string;
  watched_wallet_address: string;
  sent_at: Date;
};

export async function getPendingAlerts(userId: string): Promise<CounterpartyAlert[]> {
  const res = await query<CounterpartyAlert>(
    `SELECT id, counterparty_address, watched_wallet_address, sent_at
     FROM pending_counterparty_alerts
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY sent_at ASC`,
    [userId],
  );
  return res.rows;
}

export async function resolveAlert(params: {
  alertId: string;
  userId: string;
  status: 'labeled' | 'skipped';
}): Promise<void> {
  await query(
    `UPDATE pending_counterparty_alerts
     SET status = $1, resolved_at = NOW()
     WHERE id = $2 AND user_id = $3`,
    [params.status, params.alertId, params.userId],
  );
}
