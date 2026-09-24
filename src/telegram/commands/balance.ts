import type { Context } from 'telegraf';
import { formatAddress, escapeLegacyMarkdown, replyMarkdownSafe } from '../format.js';
import type { AuthedUser } from '../auth.js';
import { getValuedBalances, type ValuedBalance } from '../../books/balances.js';

const ASSET_ORDER = ['ETH', 'USDC', 'BNKR'];

function usd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function handleBalance(ctx: Context, user: AuthedUser): Promise<void> {
  const valued = await getValuedBalances(user.userId);

  if (valued.balances.length === 0) {
    await ctx.reply('No balance snapshots yet — sync is still running.');
    return;
  }

  const lines: string[] = ['💼 *Balances*', ''];

  const wallets = new Map<string, ValuedBalance[]>();
  for (const row of valued.balances) {
    const existing = wallets.get(row.wallet_address) ?? [];
    existing.push(row);
    wallets.set(row.wallet_address, existing);
  }

  for (const [address, assets] of wallets) {
    const label = assets[0].wallet_label;
    const addr = formatAddress(address).replace(/`/g, '');
    const header = label
      ? `\`${addr}\` (${escapeLegacyMarkdown(label)})`
      : `\`${addr}\``;
    lines.push(header);

    assets.sort((a, b) => ASSET_ORDER.indexOf(a.asset) - ASSET_ORDER.indexOf(b.asset));
    for (const asset of assets) {
      const decimals = asset.asset === 'USDC' ? 2 : 4;
      const amount = asset.balance.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      const value = asset.asset === 'USDC' || asset.usd_value === null ? '' : `  ($${usd(asset.usd_value)})`;
      lines.push(`  ${escapeLegacyMarkdown(asset.asset.padEnd(6))} ${amount}${value}`);
    }
    lines.push('');
  }

  lines.push(`Total  $${usd(valued.total_usd)}`);
  if (valued.total_incomplete) {
    lines.push('_Live price unavailable for some holdings, so the total is incomplete._');
  }

  await replyMarkdownSafe(ctx, lines.join('\n'));
}
