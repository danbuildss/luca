import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getEventsForReview } from '../../corrections/store.js';
import { formatAddress, formatAmount } from '../format.js';
import type { AuthedUser } from '../auth.js';

const LABEL_BUTTONS = [
  [
    Markup.button.callback('Revenue', 'label:__ID__:revenue'),
    Markup.button.callback('Expense', 'label:__ID__:expense'),
  ],
  [
    Markup.button.callback('Gas', 'label:__ID__:gas'),
    Markup.button.callback('Internal', 'label:__ID__:internal_transfer'),
    Markup.button.callback('Skip', 'skip:__ID__'),
  ],
];

function buildKeyboard(eventId: string) {
  const rows = LABEL_BUTTONS.map((row) =>
    row.map((btn) => ({
      ...btn,
      callback_data: btn.callback_data?.replace(/__ID__/g, eventId),
    })),
  );
  return Markup.inlineKeyboard(rows);
}

export async function handleReview(ctx: Context, user: AuthedUser): Promise<void> {
  const events = await getEventsForReview({ userId: user.userId, label: 'unknown', limit: 5 });

  if (events.length === 0) {
    await ctx.reply('Nothing needs your attention. Every transfer is labeled.');
    return;
  }

  const one = events.length === 1;
  await ctx.reply(`${events.length} ${one ? 'transfer needs' : 'transfers need'} context. Tap a label on each, or tell me what ${one ? 'it was' : 'they were'} in a message.`);

  for (const evt of events) {
    const from = formatAddress(evt.from_address);
    const to = evt.to_address ? formatAddress(evt.to_address) : '—';
    const amount = formatAmount(
      evt.amount != null ? String(evt.amount) : null,
      evt.asset ?? 'ETH',
    );
    const verb = evt.direction === 'in' ? 'Received' : 'Sent';
    const date = new Date(evt.block_time).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });

    const text = evt.direction === 'in'
      ? `${verb} ${amount} from ${from} on ${date}.`
      : `${verb} ${amount} to ${to} on ${date}.`;

    await ctx.reply(text, buildKeyboard(evt.id));
  }
}
