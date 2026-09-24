import type { Context } from 'telegraf';
import { query } from '../../db.js';
import { formatAddress, escapeLegacyMarkdown, replyMarkdownSafe } from '../format.js';
import type { AuthedUser } from '../auth.js';
import { getBankrPortfolio } from '../../bankr/portfolio.js';

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
  const [rows, bankr] = await Promise.all([
    getLatestBalances(user.userId),
    getBankrPortfolio(user.userId),
  ]);

  if (rows.length === 0 && !bankr.available) {
    await ctx.reply('No balance snapshots yet — sync is still running.');
    return;
  }

  const lines: string[] = ['💼 *Balances*', ''];

  // --- Our indexed wallets ---
  if (rows.length > 0) {
    const wallets = new Map<string, BalanceRow[]>();
    for (const row of rows) {
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

      for (const asset of assets) {
        const bal = parseFloat(asset.balance);
        const formatted = bal.toLocaleString('en-US', {
          minimumFractionDigits: asset.asset === 'ETH' ? 4 : 2,
          maximumFractionDigits: asset.asset === 'ETH' ? 4 : 2,
        });
        lines.push(`  ${escapeLegacyMarkdown(asset.asset.padEnd(6))} ${formatted}`);
      }
      lines.push('');
    }
  }

  // --- Bankr DeFi positions ---
  if (bankr.available && bankr.defiPositions.length > 0) {
    lines.push('🏦 *DeFi positions*', '');
    for (const pos of bankr.defiPositions) {
      const usd = pos.usd_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      lines.push(`  ${escapeLegacyMarkdown(String(pos.protocol))} (${escapeLegacyMarkdown(String(pos.position_type))})  $${usd}`);
      for (const asset of pos.assets) {
        lines.push(`    ${escapeLegacyMarkdown(String(asset.symbol))} ${parseFloat(asset.balance).toFixed(4)}`);
      }
    }
    lines.push('');
    const total = bankr.totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    lines.push(`Portfolio total  $${total}`);
  }

  await replyMarkdownSafe(ctx, lines.join('\n'));
}
