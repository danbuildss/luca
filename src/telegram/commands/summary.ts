import type { Context } from 'telegraf';
import { getPnlSummary } from '../../books/query.js';
import { formatPeriod } from '../format.js';
import type { AuthedUser } from '../auth.js';

export async function handleSummary(ctx: Context, user: AuthedUser, args: string[]): Promise<void> {
  const raw = args[0] ?? '30';
  const days = raw === '7' ? 7 : raw === '90' ? 90 : 30;

  const pnl = await getPnlSummary(user.userId, days);

  const rev = pnl.revenue_usdc.toFixed(2);
  const exp = pnl.expenses_usdc.toFixed(2);
  const gas = pnl.gas_usdc.toFixed(2);
  const net = pnl.net_usdc;
  const netSign = net >= 0 ? '+' : '−';
  const unknownLine =
    pnl.unknown_count > 0
      ? `\n❓ Unknown       ${pnl.unknown_count} events — /review to label`
      : undefined;
  const pendingLine =
    pnl.pending_count > 0
      ? `\n⏳ ${pnl.pending_count} transactions still being classified — not in these totals yet`
      : undefined;

  const lines = [
    `📊 *${formatPeriod(days)}*`,
    ``,
    `💰 Revenue      +$${rev}`,
    `💸 Expenses     −$${exp}`,
    `⛽ Gas          −$${gas}`,
    `─────────────────────`,
    `📈 Net          ${netSign}$${Math.abs(net).toFixed(2)}`,
    unknownLine,
    pendingLine,
  ].filter((l) => l !== undefined);

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}
