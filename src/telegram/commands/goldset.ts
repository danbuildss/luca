import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getNextForGoldSet, getGoldSetCount } from '../../quality/goldset.js';
import { formatAddress, formatAmount } from '../format.js';
import type { AuthedUser } from '../auth.js';

// Callback format: gs:<eventId>:<label>  (max 57 bytes — fits 64-byte limit)
// Skip format:     gs_skip:<eventId>

const LABEL_ROWS = [
  ['revenue', 'expense', 'gas'],
  ['internal_transfer', 'treasury', 'refund'],
  ['x402_income', 'x402_spend', 'unknown'],
];

const LABEL_DISPLAY: Record<string, string> = {
  revenue: 'Revenue',
  expense: 'Expense',
  gas: 'Gas',
  internal_transfer: 'Internal',
  treasury: 'Treasury',
  refund: 'Refund',
  x402_income: 'x402 in',
  x402_spend: 'x402 out',
  unknown: 'Unknown',
};

function buildKeyboard(eventId: string) {
  const rows = LABEL_ROWS.map((row) =>
    row.map((label) =>
      Markup.button.callback(LABEL_DISPLAY[label] ?? label, `gs:${eventId}:${label}`),
    ),
  );
  rows.push([Markup.button.callback('⏭ Skip', `gs_skip:${eventId}`)]);
  return Markup.inlineKeyboard(rows);
}

export async function handleGoldSet(ctx: Context, user: AuthedUser): Promise<void> {
  const [candidate, count] = await Promise.all([
    getNextForGoldSet(user.userId),
    getGoldSetCount(user.userId),
  ]);

  if (!candidate) {
    await ctx.reply(
      `🏅 *Gold set*\n\nAll classified transactions have been labeled.\n\n` +
      `Total in gold set: ${count}`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const counterparty = candidate.direction === 'in'
    ? candidate.from_address
    : (candidate.to_address ?? candidate.from_address);

  const amount = formatAmount(
    candidate.amount != null ? String(candidate.amount) : null,
    candidate.asset ?? 'ETH',
  );
  const dir = candidate.direction === 'in' ? '↓ in' : '↑ out';
  const date = new Date(candidate.block_time).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const hashSnip = candidate.hash ? candidate.hash.slice(0, 10) + '…' : '—';
  const confLine = candidate.current_confidence != null
    ? `${(candidate.current_confidence * 100).toFixed(0)}% confidence`
    : 'no confidence';

  const text = [
    `🏅 *Gold set labeling* — ${count} labeled so far`,
    '',
    `${amount} ${dir}  •  ${date}`,
    `Counterparty: ${formatAddress(counterparty)}`,
    `Hash: ${hashSnip}`,
    '',
    `Luca says: *${candidate.current_label}* via ${candidate.current_method ?? '?'} (${confLine})`,
    '',
    `Is this correct? Tap the true label ↓`,
  ].join('\n');

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...buildKeyboard(candidate.event_id),
  });
}
