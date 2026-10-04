import { Telegram } from 'telegraf';
import { query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendPlainWithLinks } from '../telegram/format.js';
import { ANY_HOUR_ALERTS, isQuietHours } from '../notify/quiet-hours.js';

type UndeliveredAlert = {
  id: string;
  telegram_id: string;
  message: string;
  type: string;
  timezone: string;
};

// "Luca's worker has stopped" is sent by the Telegram process (deliverWorkerStaleAlerts):
// the worker cannot send anything while it is stopped
const SENT_BY_BOT = 'worker_stale';
const ADMIN_ONLY_ALERTS = ['worker_stale', 'wallet_stale', 'disk_pressure', 'classifier_degradation'];

// Alerts waiting for this user that may go out now: overnight in their timezone, only
// the few that go out at any hour (src/notify/quiet-hours.ts); the rest wait for 08:00
export async function getUndeliveredAlerts(userId: string, now: Date = new Date()): Promise<UndeliveredAlert[]> {
  const res = await query<UndeliveredAlert>(
    `SELECT a.id, u.telegram_id::text AS telegram_id, a.message, a.type, u.timezone
     FROM alerts a
     JOIN users u ON u.id = a.user_id
     WHERE a.user_id = $1 AND a.sent_at IS NULL AND a.delivery_failed_at IS NULL
       AND a.type <> $2
       -- About Luca itself: admins only, including anything queued for an operator before
       AND (u.role = 'admin' OR a.type <> ALL($3::text[]))
     ORDER BY a.created_at ASC`,
    [userId, SENT_BY_BOT, ADMIN_ONLY_ALERTS],
  );
  return res.rows.filter((a) => ANY_HOUR_ALERTS.has(a.type) || !isQuietHours(a.timezone, now));
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
  await send(userId, await getUndeliveredAlerts(userId), new Telegram(config.TELEGRAM_BOT_TOKEN));
}

// Run by the Telegram process: "Luca's worker has stopped", to the admins it was queued for
export async function deliverWorkerStaleAlerts(telegram: Telegram): Promise<void> {
  const rows = (await query<UndeliveredAlert & { user_id: string }>(
    `SELECT a.id, a.user_id, u.telegram_id::text AS telegram_id, a.message, a.type, u.timezone
     FROM alerts a
     JOIN users u ON u.id = a.user_id
     WHERE a.type = $1 AND u.role = 'admin' AND a.sent_at IS NULL AND a.delivery_failed_at IS NULL
     ORDER BY a.created_at ASC`,
    [SENT_BY_BOT],
  )).rows;
  for (const userId of new Set(rows.map((r) => r.user_id))) {
    await send(userId, rows.filter((r) => r.user_id === userId), telegram);
  }
}

async function send(userId: string, alerts: UndeliveredAlert[], telegram: Telegram): Promise<void> {
  for (const alert of alerts) {
    try {
      // Plain text: alert messages carry labels and names Luca did not write. Any
      // BaseScan link in them is kept tappable.
      await sendPlainWithLinks(
        (t, x) => telegram.sendMessage(Number(alert.telegram_id), t, x as Parameters<Telegram['sendMessage']>[2]),
        alert.message,
      );
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
