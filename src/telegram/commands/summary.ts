import type { Context } from 'telegraf';
import { getPnlSummary } from '../../books/query.js';
import { figuresBlock } from '../format.js';
import type { AuthedUser } from '../auth.js';

function money(amount: number, sign: '+' | '-' | '' = ''): string {
  const abs = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${abs}`;
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
      ['Revenue', money(pnl.revenue_usdc, '+')],
      ['Expenses', money(pnl.expenses_usdc, '-')],
      ['Gas', money(pnl.gas_usdc, '-')],
      ['Net', money(net, net < 0 ? '-' : '+')],
    ]),
  ];

  const notes: string[] = [];
  if (pnl.unknown_count > 0) {
    notes.push(`${pnl.unknown_count} ${pnl.unknown_count === 1 ? 'transfer needs' : 'transfers need'} context. Tell me what ${pnl.unknown_count === 1 ? 'it was' : 'they were'} and I will label ${pnl.unknown_count === 1 ? 'it' : 'them'}.`);
  }
  if (pnl.pending_count > 0) {
    notes.push(`${pnl.pending_count} ${pnl.pending_count === 1 ? 'transfer is' : 'transfers are'} still being classified and not in these totals yet.`);
  }
  if (notes.length > 0) lines.push('', ...notes);

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}
