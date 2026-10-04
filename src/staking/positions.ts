import { query } from '../db.js';
import { SUPPORTED_TOKENS, type SupportedSymbol } from '../ingestion/assets.js';

// What an operator has staked, as the staking contract itself reported it (stakeOf and
// the like) at the last staking transfer Luca checked for that wallet (stake_checks,
// migration 027). Staked tokens are still the operator's: they count in their holdings,
// listed apart from what sits in the wallet. Nothing is estimated: no reading, no line.

export type StakedPosition = {
  wallet_id: string;
  wallet_address: string;
  wallet_label: string | null;
  contract: string;
  asset: SupportedSymbol;
  amount: number;
  as_of: Date;
};

// Smallest units to a number, without going through a float for the integer part
export function fromUnits(raw: string, decimals: number): number {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0');
  return parseFloat(`${whole}.${frac}`);
}

export async function stakedPositions(userId: string, walletId?: string): Promise<StakedPosition[]> {
  const rows = (await query<{
    wallet_id: string; wallet_address: string; wallet_label: string | null;
    contract: string; staking_token: string | null; staked_after: string; as_of: Date;
  }>(
    `SELECT DISTINCT ON (sc.wallet_id, sc.contract)
            sc.wallet_id, w.address AS wallet_address, w.label AS wallet_label, sc.contract,
            k.staking_token, sc.evidence->>'staked_after' AS staked_after, ne.block_time AS as_of
     FROM stake_checks sc
     JOIN wallets w ON w.id = sc.wallet_id AND w.user_id = $1 AND w.active = TRUE
     JOIN staking_contracts k ON k.address = sc.contract AND k.is_staking
     JOIN normalized_events ne ON ne.id = sc.event_id
     WHERE sc.user_id = $1 AND sc.evidence->>'staked_after' IS NOT NULL
       AND ($2::uuid IS NULL OR sc.wallet_id = $2::uuid)
     ORDER BY sc.wallet_id, sc.contract, sc.block_number DESC, ne.block_time DESC`,
    [userId, walletId ?? null],
  )).rows;

  const out: StakedPosition[] = [];
  for (const r of rows) {
    const token = r.staking_token ? SUPPORTED_TOKENS[r.staking_token] : undefined;
    if (!token || !/^\d+$/.test(r.staked_after)) continue;
    const amount = fromUnits(r.staked_after, token.decimals);
    if (amount <= 0) continue;
    out.push({
      wallet_id: r.wallet_id, wallet_address: r.wallet_address, wallet_label: r.wallet_label,
      contract: r.contract, asset: token.symbol, amount, as_of: r.as_of,
    });
  }
  return out;
}
