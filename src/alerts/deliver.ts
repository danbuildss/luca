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
     WHERE a.user_id = $1 AND a.sent_at IS NULL
     ORDER BY a.created_at ASC`,
    [userId],
  );
  return res.rows;
}

async function markAlertSent(alertId: string): Promise<void> {
  await query(`UPDATE alerts SET sent_at = NOW() WHERE id = $1`, [alertId]);
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
      logger.error({ err, alertId: alert.id, type: alert.type }, 'Failed to deliver alert');
    }
  }
}
