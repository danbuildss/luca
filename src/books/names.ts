import { query } from '../db.js';
import { formatAddress } from '../telegram/format.js';
import { SUPPORTED_TOKENS } from '../ingestion/assets.js';

// What Luca calls an address, the same everywhere it speaks (the morning message, alerts,
// questions, top counterparties). In order:
//   1. one of the operator's own wallets   "your Luca wallet", "your main wallet"
//   2. a name the operator gave it         "OpenAI"
//   3. the operator's creator-fee contract "the ACCUM fee contract"
//   4. a staking contract Luca recognised  "the BNKR staking contract"
//   5. otherwise the short address         "0x1231…4eae"
// Names are the operator's own words or public chain facts; nothing of another operator's.
// Names may hold any characters: callers escape them for Markdown.

export type Namer = (address: string | null | undefined, direction?: 'in' | 'out') => string;

const ADDRESS_LIKE = /^\s*0x[0-9a-f]{4,}(?:…|\.\.\.)?[0-9a-f]*\s*$/i;

// A name that is only an address says nothing ("named the recipient "0x8847…584a"")
export function isAddressLike(name: string | null | undefined): boolean {
  return !name || ADDRESS_LIKE.test(name);
}

export function ownWalletName(label: string | null, address: string): string {
  const l = label?.trim();
  if (!l || isAddressLike(l)) return `your wallet ${formatAddress(address)}`;
  return /\bwallet$/i.test(l) ? `your ${l}` : `your ${l} wallet`;
}

export async function namesFor(userId: string): Promise<Namer> {
  const [wallets, rules, fees, staking] = await Promise.all([
    query<{ address: string; label: string | null }>(
      `SELECT LOWER(address) AS address, label FROM wallets WHERE user_id = $1`, [userId]),
    query<{ address: string; name: string; direction: 'in' | 'out' | null }>(
      `SELECT LOWER(address) AS address, name, direction FROM counterparty_rules
       WHERE user_id = $1 AND name IS NOT NULL AND name <> ''`, [userId]),
    query<{ fee_contract: string; token_symbol: string }>(
      `SELECT LOWER(fs.fee_contract) AS fee_contract, fs.token_symbol FROM fee_sources fs
       WHERE fs.user_id = $1`, [userId]),
    query<{ address: string; staking_token: string | null }>(
      `SELECT address, staking_token FROM staking_contracts WHERE is_staking`, []),
  ]);

  const own = new Map(wallets.rows.map((w) => [w.address, ownWalletName(w.label, w.address)]));
  const given = new Map<string, string>();
  for (const r of rules.rows) {
    if (isAddressLike(r.name)) continue;
    const name = r.name.trim().slice(0, 40);
    given.set(`${r.address}|${r.direction ?? '*'}`, name);
  }
  const feeNames = new Map(fees.rows.map((f) => [f.fee_contract, `the ${f.token_symbol.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 20) || 'creator'} fee contract`]));
  const stakeNames = new Map(staking.rows.map((s) => {
    const sym = s.staking_token ? SUPPORTED_TOKENS[s.staking_token]?.symbol : undefined;
    return [s.address, sym ? `the ${sym} staking contract` : 'a staking contract'];
  }));

  return (address, direction) => {
    if (!address) return 'an unknown address';
    const a = address.toLowerCase();
    return own.get(a)
      ?? (direction ? given.get(`${a}|${direction}`) : undefined)
      ?? given.get(`${a}|*`)
      ?? given.get(`${a}|in`) ?? given.get(`${a}|out`)
      ?? feeNames.get(a)
      ?? stakeNames.get(a)
      ?? formatAddress(address);
  };
}
