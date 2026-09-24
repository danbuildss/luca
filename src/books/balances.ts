import { query } from '../db.js';
import { getSpotPrices } from '../ingestion/price.js';

export type ValuedBalance = {
  wallet_id: string;
  wallet_address: string;
  wallet_label: string | null;
  asset: string;
  balance: number;
  snapshot_at: Date;
  usd_value: number | null; // null when the live price is unavailable
};

export type ValuedBalances = {
  balances: ValuedBalance[];
  total_usd: number;
  // True when a non-zero ETH/BNKR holding could not be priced, so total_usd is too low
  total_incomplete: boolean;
  prices: { ETH: number | null; BNKR: number | null };
};

// Latest ETH, USDC and BNKR snapshot per active wallet, valued at live prices
// (USDC at $1).
export async function getValuedBalances(userId: string): Promise<ValuedBalances> {
  const res = await query<{
    wallet_id: string;
    wallet_address: string;
    wallet_label: string | null;
    asset: string;
    balance: string;
    snapshot_at: Date;
  }>(
    `SELECT DISTINCT ON (bs.wallet_id, bs.asset)
       bs.wallet_id, w.address AS wallet_address, w.label AS wallet_label,
       bs.asset, bs.balance::text AS balance, bs.snapshot_at
     FROM balance_snapshots bs
     JOIN wallets w ON w.id = bs.wallet_id
     WHERE bs.user_id = $1 AND w.user_id = $1 AND w.active = TRUE
       AND bs.asset IN ('ETH', 'USDC', 'BNKR')
     ORDER BY bs.wallet_id, bs.asset, bs.snapshot_at DESC`,
    [userId],
  );

  const needsPrice = res.rows.some((r) => r.asset !== 'USDC' && parseFloat(r.balance) > 0);
  const prices = needsPrice ? await getSpotPrices() : { ETH: null, BNKR: null };

  let total = 0;
  let incomplete = false;
  const balances = res.rows.map((r): ValuedBalance => {
    const balance = parseFloat(r.balance);
    const price = r.asset === 'USDC' ? 1 : prices[r.asset as 'ETH' | 'BNKR'];
    const usd = balance === 0 ? 0 : price === null ? null : balance * price;
    if (usd === null) incomplete = true;
    else total += usd;
    return { ...r, balance, usd_value: usd };
  });

  return { balances, total_usd: total, total_incomplete: incomplete, prices };
}
