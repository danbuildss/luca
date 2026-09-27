import type { Telegraf, Context, Telegram } from 'telegraf';
import { logger } from '../logger.js';
import { formatAddress, formatAmount, escapeLegacyMarkdown, sendMarkdownSafe } from './format.js';
import { getQuestionsToSend, markQuestionSent, type QuestionToSend } from '../alerts/questions.js';
import { txLink } from '../ledger/links.js';
import { saveMessage } from '../agent/context.js';

function day(d: Date): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Luca's question about transfers that need context, answered in chat ("those are
// expenses", "that was infrastructure"); no buttons. src/agent/changes.ts turns the answer
// into a change the operator confirms.
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
    // The transaction itself, tappable on BaseScan
    const tx = q.hash ? `Transaction: ${txLink(q.hash)}` : null;
    return [what, ...(tx ? [tx] : []), '', 'What was it for?'].join('\n');
  }

  const total = parseFloat(q.total_usd);
  const kind = q.direction === 'in' ? `similar ${asset} transfers from` : `similar ${asset} payments to`;
  const span = day(q.first_at) === day(q.last_at) ? `on ${day(q.last_at)}` : `${day(q.first_at)} to ${day(q.last_at)}`;
  const amount = total > 0 ? `${usd(total)} total, ` : '';
  return `I have ${q.event_count} ${kind} ${who} that still need context (${amount}${span}). They look related. What were they for?`;
}

export async function sendPendingAlerts(bot: Telegraf<Context>): Promise<void> {
  const questions = await getQuestionsToSend();
  for (const q of questions) {
    try {
      const text = questionText(q);
      const sent = await sendMarkdownSafe(
        (t, x) => bot.telegram.sendMessage(Number(q.telegram_id), t, x as Parameters<Telegram['sendMessage']>[2]),
        text,
      );
      if (sent) {
        await markQuestionSent(q.id, sent.message_id);
        // In the conversation, so the operator's answer ("those are expenses") has its context
        await saveMessage({ userId: q.user_id, role: 'assistant', content: text });
      }
    } catch (err) {
      logger.error({ err, groupId: q.id }, 'Failed to send question');
    }
  }
}
