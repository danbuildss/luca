import type { Context } from 'telegraf';
import { query } from '../../db.js';
import { formatAddress } from '../format.js';
import type { AuthedUser } from '../auth.js';

type BalanceRow = {
  wallet_address: string;
  wallet_label: string | null;
  asset: string;
  balance: string;
  snapshot_at: Date;
};

async function getLatestBalances(userId: string): Promise<BalanceRow[]> {
  const res = await query<BalanceRow>(
    `SELECT DISTINCT ON (bs.wallet_id, bs.asset)
       w.address AS wallet_address,
       w.label   AS wallet_label,
       bs.asset,
       bs.balance::text AS balance,
       bs.snapshot_at
     FROM balance_snapshots bs
     JOIN wallets w ON w.id = bs.wallet_id
     WHERE bs.user_id = $1
     ORDER BY bs.wallet_id, bs.asset, bs.snapshot_at DESC`,
    [userId],
  );
  return res.rows;
}

export async function handleBalance(ctx: Context, user: AuthedUser): Promise<void> {
  const rows = await getLatestBalances(user.userId);

  if (rows.length === 0) {
    await ctx.reply('No balance snapshots yet — sync is still running.');
    return;
  }

  // Group by wallet address
  const wallets = new Map<string, BalanceRow[]>();
  for (const row of rows) {
    const existing = wallets.get(row.wallet_address) ?? [];
    existing.push(row);
    wallets.set(row.wallet_address, existing);
  }

  const lines: string[] = ['💼 *Balances*', ''];

  for (const [address, assets] of wallets) {
    const label = assets[0].wallet_label;
    const header = label
      ? `\`${formatAddress(address)}\` (${label})`
      : `\`${formatAddress(address)}\``;
    lines.push(header);

    for (const asset of assets) {
      const bal = parseFloat(asset.balance);
      const formatted = bal.toLocaleString('en-US', {
        minimumFractionDigits: asset.asset === 'ETH' ? 4 : 2,
        maximumFractionDigits: asset.asset === 'ETH' ? 4 : 2,
      });
      lines.push(`  ${asset.asset.padEnd(6)} ${formatted}`);
    }

    lines.push('');
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}
