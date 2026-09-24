import type { Context } from 'telegraf';
import { formatAddress, escapeLegacyMarkdown, replyMarkdownSafe, figuresBlock } from '../format.js';
import type { AuthedUser } from '../auth.js';
import { getValuedBalances, type ValuedBalance } from '../../books/balances.js';

const ASSET_ORDER = ['ETH', 'USDC', 'BNKR'];

function usd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function handleBalance(ctx: Context, user: AuthedUser): Promise<void> {
  const valued = await getValuedBalances(user.userId);

  if (valued.balances.length === 0) {
    await ctx.reply('I have not taken a balance snapshot yet. The first sync is still running, so check back in a minute.');
    return;
  }

  const wallets = new Map<string, ValuedBalance[]>();
  for (const row of valued.balances) {
    const existing = wallets.get(row.wallet_address) ?? [];
    existing.push(row);
    wallets.set(row.wallet_address, existing);
  }

  const count = wallets.size;
  const lines: string[] = [
    `Here is what you hold across ${count} ${count === 1 ? 'wallet' : 'wallets'}, at live prices.`,
    '',
  ];

  for (const [address, assets] of wallets) {
    const label = assets[0].wallet_label;
    const addr = formatAddress(address).replace(/`/g, '');
    lines.push(label ? `\`${addr}\` (${escapeLegacyMarkdown(label)})` : `\`${addr}\``);

    assets.sort((a, b) => ASSET_ORDER.indexOf(a.asset) - ASSET_ORDER.indexOf(b.asset));
    lines.push(figuresBlock(assets.map((asset) => {
      const decimals = asset.asset === 'USDC' ? 2 : 4;
      const amount = asset.balance.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      return [asset.asset, amount, asset.usd_value === null ? 'no price' : `$${usd(asset.usd_value)}`];
    })));
    lines.push('');
  }

  lines.push(`Total: $${usd(valued.total_usd)}`);
  if (valued.total_incomplete) {
    lines.push('A live price was unavailable for some holdings, so the total is incomplete.');
  }

  await replyMarkdownSafe(ctx, lines.join('\n'));
}
