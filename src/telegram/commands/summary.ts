import type { Context } from 'telegraf';
import { getPnlSummary } from '../../books/query.js';
import { figuresBlock, provisionalNote } from '../format.js';
import type { AuthedUser } from '../auth.js';
import type { PnlSummary } from '../../books/query.js';

function money(amount: number, sign: '+' | '-' | '' = ''): string {
  const abs = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${abs}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// At most three plain lines under the figures: what needs the operator, what is a guess,
// what is not priced or not classified yet.
export function bookNotes(pnl: PnlSummary): string[] {
  const notes: string[] = [];
  if (pnl.unknown_count > 0) {
    notes.push(`${plural(pnl.unknown_count, 'transfer needs', 'transfers need')} context. Tell me what ${pnl.unknown_count === 1 ? 'it was' : 'they were'} and I will label ${pnl.unknown_count === 1 ? 'it' : 'them'}.`);
  }
  if (pnl.provisional_count > 0) {
    notes.push(`${plural(pnl.provisional_count, 'label is', 'labels are')} my best guess, not confirmed by you or a rule.`);
  }
  const waiting = [
    pnl.unpriced_count > 0 ? `${plural(pnl.unpriced_count, 'transfer has', 'transfers have')} no price yet` : null,
    pnl.pending_count > 0 ? `${plural(pnl.pending_count, 'transfer is', 'transfers are')} still being classified` : null,
  ].filter((x): x is string => x !== null);
  if (waiting.length > 0) notes.push(`${waiting.join(' and ')}, so not in these totals.`);
  return notes;
}

export async function handleSummary(ctx: Context, user: AuthedUser, args: string[]): Promise<void> {
  const raw = args[0] ?? '30';
  const days = raw === '7' ? 7 : raw === '90' ? 90 : 30;

  const pnl = await getPnlSummary(user.userId, days);
  const net = pnl.net_usdc;

  const lines = [
    `Here are your books for the last ${days} days.`,
    '',
    figuresBlock([
      ['Revenue', money(pnl.revenue_usdc, '+'), provisionalNote(pnl.revenue_provisional_usdc)],
      ['Expenses', money(pnl.expenses_usdc, '-'), provisionalNote(pnl.expenses_provisional_usdc)],
      ['Gas', money(pnl.gas_usdc, '-'), ''],
      ['Net', money(net, net < 0 ? '-' : '+'), ''],
    ]),
  ];

  const notes = bookNotes(pnl);
  if (notes.length > 0) lines.push('', ...notes);

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}
