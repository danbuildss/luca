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

// Whether Luca has finished its first read of each active wallet. A wallet's first sync
// reads its last 30 days of transactions and takes a few minutes; until it finishes, its
// balances (if any) come only from the reading taken when tracking started.
export type WalletReadState = {
  address: string;
  label: string | null;
  tracking_since: Date;
  first_read: 'done' | 'in_progress';
  last_synced_at: Date | null;
};

export async function getWalletReadStates(userId: string): Promise<WalletReadState[]> {
  const res = await query<{ address: string; label: string | null; tracking_since: Date; last_synced_at: Date | null }>(
    `SELECT w.address, w.label, w.created_at AS tracking_since, wj.last_synced_at
     FROM wallets w
     LEFT JOIN watch_jobs wj ON wj.wallet_id = w.id
     WHERE w.user_id = $1 AND w.active = TRUE
     ORDER BY w.created_at`,
    [userId],
  );
  return res.rows.map((r) => ({ ...r, first_read: r.last_synced_at ? 'done' : 'in_progress' }));
}
