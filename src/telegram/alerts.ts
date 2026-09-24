import type { Telegraf, Context, Telegram } from 'telegraf';
import { Markup } from 'telegraf';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { formatAddress, formatAmount, escapeLegacyMarkdown, sendMarkdownSafe } from './format.js';

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
  direction: 'in' | 'out';
  block_time: Date;
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
       ne.id AS event_id,
       ne.direction,
       ne.block_time
     FROM pending_counterparty_alerts pca
     JOIN users u ON u.id = pca.user_id
     -- the most recent unknown supported event from this counterparty; alerts with none
     -- (e.g. only spam tokens) are never sent
     JOIN LATERAL (
       SELECT ne2.id, ne2.amount, ne2.asset, ne2.direction, ne2.block_time
       FROM normalized_events ne2
       JOIN classifications c ON c.event_id = ne2.id AND c.superseded_at IS NULL
       WHERE ne2.user_id = pca.user_id
         AND ne2.supported IS TRUE
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
      // Address inside a code span: strip backticks rather than escape them.
      const addrShort = formatAddress(alert.counterparty_address).replace(/`/g, '');
      // Token symbol is chain/attacker-controlled — escape and cap before embedding.
      const asset = escapeLegacyMarkdown((alert.asset ?? 'USDC').slice(0, 20));
      const amountStr = formatAmount(alert.amount, asset);

      const date = new Date(alert.block_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const what = alert.direction === 'in'
        ? `You received ${amountStr} from \`${addrShort}\` on ${date}.`
        : `You sent ${amountStr} to \`${addrShort}\` on ${date}.`;
      const text = [
        what,
        '',
        'What was it for? Tap a label below, or just tell me in a message.',
      ].join('\n');

      const keyboard = buildAlertKeyboard(alert.id, alert.event_id);
      const sent = await sendMarkdownSafe(
        (t, x) => bot.telegram.sendMessage(chatId, t, x as Parameters<Telegram['sendMessage']>[2]),
        text,
        { reply_markup: keyboard.reply_markup },
      );

      if (sent) await markAlertSent(alert.id, sent.message_id);
    } catch (err) {
      logger.error({ err, alertId: alert.id }, 'Failed to send counterparty alert');
    }
  }
}
