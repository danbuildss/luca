import type { Telegraf, Context, Telegram } from 'telegraf';
import { Markup } from 'telegraf';
import { logger } from '../logger.js';
import { formatAddress, formatAmount, escapeLegacyMarkdown, sendMarkdownSafe } from './format.js';
import { getQuestionsToSend, markQuestionSent, type QuestionToSend } from '../alerts/questions.js';

// Callback data stays under Telegram's 64-byte limit: qg:<uuid>:internal_transfer is 57.
function questionKeyboard(groupId: string) {
  const p = `qg:${groupId}`;
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Revenue', `${p}:revenue`),
      Markup.button.callback('Expense', `${p}:expense`),
    ],
    [
      Markup.button.callback('Internal', `${p}:internal_transfer`),
      Markup.button.callback('Refund', `${p}:refund`),
      Markup.button.callback('Skip', `qg_skip:${groupId}`),
    ],
  ]);
}

function day(d: Date): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function questionText(q: QuestionToSend): string {
  // Address inside a code span: strip backticks rather than escape them.
  const who = `\`${formatAddress(q.counterparty_address).replace(/`/g, '')}\``;
  // Token symbol is chain-controlled — escape and cap before embedding.
  const asset = escapeLegacyMarkdown((q.asset ?? 'ETH').slice(0, 20));

  if (q.event_count === 1) {
    const amount = formatAmount(q.amount, asset);
    const what = q.direction === 'in'
      ? `You received ${amount} from ${who} on ${day(q.last_at)}.`
      : `You sent ${amount} to ${who} on ${day(q.last_at)}.`;
    return [what, '', 'What was it for? Tap a label below, or just tell me in a message.'].join('\n');
  }

  const total = parseFloat(q.total_usd);
  const kind = q.direction === 'in' ? `incoming ${asset} transfers from` : `outgoing ${asset} payments to`;
  const span = day(q.first_at) === day(q.last_at) ? `on ${day(q.last_at)}` : `${day(q.first_at)} to ${day(q.last_at)}`;
  const amount = total > 0 ? `, ${usd(total)} total` : '';
  return [
    `${q.event_count} ${kind} ${who}${amount}, ${span}.`,
    '',
    `What are these? One tap labels all ${q.event_count}, or just tell me in a message.`,
  ].join('\n');
}

export async function sendPendingAlerts(bot: Telegraf<Context>): Promise<void> {
  const questions = await getQuestionsToSend();
  for (const q of questions) {
    try {
      const sent = await sendMarkdownSafe(
        (t, x) => bot.telegram.sendMessage(Number(q.telegram_id), t, x as Parameters<Telegram['sendMessage']>[2]),
        questionText(q),
        { reply_markup: questionKeyboard(q.id).reply_markup },
      );
      if (sent) await markQuestionSent(q.id, sent.message_id);
    } catch (err) {
      logger.error({ err, groupId: q.id }, 'Failed to send question');
    }
  }
}
