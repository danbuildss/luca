import { Telegram } from 'telegraf';
import { query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

type UndeliveredAlert = {
  id: string;
  telegram_id: string;
  message: string;
  type: string;
};

async function getUndeliveredAlerts(userId: string): Promise<UndeliveredAlert[]> {
  const res = await query<UndeliveredAlert>(
    `SELECT a.id, u.telegram_id::text AS telegram_id, a.message, a.type
     FROM alerts a
     JOIN users u ON u.id = a.user_id
     WHERE a.user_id = $1 AND a.sent_at IS NULL AND a.delivery_failed_at IS NULL
     ORDER BY a.created_at ASC`,
    [userId],
  );
  return res.rows;
}

async function markAlertSent(alertId: string): Promise<void> {
  await query(`UPDATE alerts SET sent_at = NOW() WHERE id = $1`, [alertId]);
}

// Permanent failure (bot blocked / chat gone): mark every pending alert for the user
// as undeliverable so the 60s worker loop stops retrying them forever.
async function markUserAlertsUndeliverable(userId: string, reason: string): Promise<void> {
  await query(
    `UPDATE alerts SET delivery_failed_at = NOW(), delivery_error = $2
     WHERE user_id = $1 AND sent_at IS NULL AND delivery_failed_at IS NULL`,
    [userId, reason],
  );
}

// Telegram 403 = "bot was blocked by the user" / "user is deactivated" — retrying won't help.
function isPermanentDeliveryError(err: unknown): boolean {
  const code = (err as { response?: { error_code?: number } } | null)?.response?.error_code;
  return code === 403;
}

export async function deliverPendingAlerts(userId: string): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) return;

  const alerts = await getUndeliveredAlerts(userId);
  if (alerts.length === 0) return;

  const telegram = new Telegram(config.TELEGRAM_BOT_TOKEN);

  for (const alert of alerts) {
    try {
      await telegram.sendMessage(Number(alert.telegram_id), alert.message);
      await markAlertSent(alert.id);
    } catch (err) {
      if (isPermanentDeliveryError(err)) {
        const description = (err as { response?: { description?: string } }).response?.description ?? '403';
        logger.warn({ userId, alertId: alert.id, description }, 'Alert delivery blocked — marking pending alerts undeliverable');
        await markUserAlertsUndeliverable(userId, description);
        return;
      }
      logger.error({ err, alertId: alert.id, type: alert.type }, 'Failed to deliver alert');
    }
  }
}
