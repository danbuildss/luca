import { query } from '../db.js';
import { logger } from '../logger.js';

// Alert threshold: unknown events above this USD value get a pending alert
const ALERT_THRESHOLD_USD = 10;

export type CounterpartyAlert = {
  id: string;
  counterparty_address: string;
  watched_wallet_address: string;
  sent_at: Date;
};

export type NewAlertInfo = {
  counterpartyAddress: string;
  watchedWalletAddress: string;
  amount: number | null;
  asset: string | null;
};

export async function detectUnknownCounterparties(userId: string): Promise<NewAlertInfo[]> {
  // Find distinct counterparties from unknown events above threshold
  // that don't already have a pending_counterparty_alert row for this user
  const res = await query<{
    counterparty_address: string;
    wallet_address: string;
    amount: string | null;
    asset: string | null;
  }>(
    `SELECT DISTINCT
       CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END
         AS counterparty_address,
       w.address AS wallet_address,
       ne.amount::text AS amount,
       ne.asset
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     JOIN wallets w ON w.id = ne.wallet_id
     WHERE ne.user_id = $1
       AND c.label = 'unknown'
       AND c.superseded_at IS NULL
       AND COALESCE(ne.usd_value, CASE WHEN ne.asset = 'USDC' THEN ne.amount ELSE NULL END)
           >= $2
       AND NOT EXISTS (
         SELECT 1 FROM pending_counterparty_alerts pca
         WHERE pca.user_id = $1
           AND pca.counterparty_address =
             CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END
       )`,
    [userId, ALERT_THRESHOLD_USD],
  );

  if (res.rows.length === 0) return [];

  const created: NewAlertInfo[] = [];
  for (const row of res.rows) {
    if (!row.counterparty_address) continue;
    try {
      const inserted = await query<{ id: string }>(
        `INSERT INTO pending_counterparty_alerts (user_id, counterparty_address, watched_wallet_address)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, counterparty_address) DO NOTHING
         RETURNING id`,
        [userId, row.counterparty_address, row.wallet_address],
      );
      if (inserted.rows.length > 0) {
        created.push({
          counterpartyAddress: row.counterparty_address,
          watchedWalletAddress: row.wallet_address,
          amount: row.amount != null ? parseFloat(row.amount) : null,
          asset: row.asset,
        });
      }
    } catch (err) {
      logger.error({ err, address: row.counterparty_address }, 'Failed to insert counterparty alert');
    }
  }

  if (created.length > 0) {
    logger.info({ userId, count: created.length }, 'New counterparty alerts queued');
  }
  return created;
}

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
