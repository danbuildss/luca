import type { Telegraf, Context } from 'telegraf';
import { Markup } from 'telegraf';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { formatAddress, formatAmount } from './format.js';

type UnsentAlert = {
  id: string;
  user_id: string;
  telegram_id: string;
  counterparty_address: string;
  watched_wallet_address: string;
  // representative event for amount/asset display
  amount: string | null;
  asset: string | null;
  event_id: string | null;
};

async function getUnsentAlerts(): Promise<UnsentAlert[]> {
  const res = await query<UnsentAlert>(
    `SELECT
       pca.id,
       pca.user_id,
       u.telegram_id::text AS telegram_id,
       pca.counterparty_address,
       pca.watched_wallet_address,
       ne.amount::text AS amount,
       ne.asset,
       ne.id AS event_id
     FROM pending_counterparty_alerts pca
     JOIN users u ON u.id = pca.user_id
     -- pick the most recent unknown event from this counterparty for display
     LEFT JOIN LATERAL (
       SELECT ne2.id, ne2.amount, ne2.asset
       FROM normalized_events ne2
       JOIN classifications c ON c.event_id = ne2.id AND c.superseded_at IS NULL
       WHERE ne2.user_id = pca.user_id
         AND c.label = 'unknown'
         AND CASE WHEN ne2.direction = 'in' THEN ne2.from_address ELSE ne2.to_address END
             = pca.counterparty_address
       ORDER BY ne2.block_time DESC
       LIMIT 1
     ) ne ON TRUE
     WHERE pca.status = 'pending'
       AND pca.telegram_message_id IS NULL`,
  );
  return res.rows;
}

async function markAlertSent(alertId: string, messageId: number): Promise<void> {
  await query(
    `UPDATE pending_counterparty_alerts SET telegram_message_id = $1 WHERE id = $2`,
    [messageId, alertId],
  );
}

function buildAlertKeyboard(alertId: string, eventId: string | null) {
  if (!eventId) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('Skip', `alert_skip:${alertId}`)],
    ]);
  }
  // Use short prefix to stay under Telegram's 64-byte callback_data limit.
  // Format: al:<alertId>:<label> — eventId is resolved server-side from alertId.
  const p = `al:${alertId}`;
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Revenue', `${p}:revenue`),
      Markup.button.callback('Expense', `${p}:expense`),
    ],
    [
      Markup.button.callback('Gas', `${p}:gas`),
      Markup.button.callback('Internal', `${p}:internal_transfer`),
      Markup.button.callback('Skip', `alert_skip:${alertId}`),
    ],
  ]);
}

export async function sendPendingAlerts(bot: Telegraf<Context>): Promise<void> {
  const alerts = await getUnsentAlerts();
  if (alerts.length === 0) return;

  for (const alert of alerts) {
    try {
      const chatId = Number(alert.telegram_id);
      // Sanitize before embedding — NOTES.md security rule
      const addrShort = formatAddress(alert.counterparty_address);
      const amountStr = formatAmount(alert.amount, alert.asset ?? 'USDC');

      const text = [
        '❓ *New unknown transfer*',
        `From: \`${addrShort}\``,
        `Amount: ${amountStr}`,
        '',
        'What is this?',
      ].join('\n');

      const sent = await bot.telegram.sendMessage(
        chatId,
        text,
        {
          parse_mode: 'Markdown',
          ...buildAlertKeyboard(alert.id, alert.event_id),
        },
      );

      await markAlertSent(alert.id, sent.message_id);
    } catch (err) {
      logger.error({ err, alertId: alert.id }, 'Failed to send counterparty alert');
    }
  }
}
