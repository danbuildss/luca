import type { TxShape } from '../types/index.js';

// Wrapped ETH on Base. Wrapping and unwrapping convert ETH into WETH and back, so for
// the shape of a transaction WETH counts as ETH (it is never in the books itself).
export const BASE_WETH = '0x4200000000000000000000000000000000000006';

// Every recorded movement of one transaction for one operator (all their wallets).
export type Leg = {
  id: string;
  direction: 'in' | 'out';
  asset: string | null;
  token_address: string | null; // lowercase contract; NULL for native ETH
  supported: boolean | null;    // TRUE = ETH/USDC/BNKR; FALSE = untracked or spam
  amount: number | null;
  source_key: string;
  from_address: string;
  to_address: string | null;
};

export type TxShapeResult = {
  shape: TxShape;
  // One line for the label's evidence, e.g. "Swapped 100 USDC for 25,000 BNKR"
  summary: string;
};

function assetKey(l: Leg): string {
  const token = l.token_address?.toLowerCase() ?? null;
  return token === null || token === BASE_WETH ? 'eth' : token;
}

function isInternal(l: Leg, wallets: Set<string>): boolean {
  return wallets.has(l.from_address.toLowerCase()) && wallets.has((l.to_address ?? '').toLowerCase());
}

function fmt(n: number): string {
  return Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

// What a transaction was, from all of its movements:
//   gas      - nothing but the network fee (a failed transaction, an approval)
//   internal - only moves between the operator's own wallets
//   swap     - one tracked asset out, another tracked asset in (wrapping ETH included)
//   single   - payments in one direction (one or several)
//   complex  - anything else: mixed directions that are not a clean swap, or a token
//              Luca does not track moving against a tracked one. Never guessed.
export function txShape(legs: Leg[], walletAddresses: string[]): TxShapeResult {
  const wallets = new Set(walletAddresses.map((a) => a.toLowerCase()));
  const moving = legs.filter((l) => l.source_key !== 'gas' && (l.amount ?? 0) > 0 && !isInternal(l, wallets));
  const tracked = moving.filter((l) => l.supported === true || assetKey(l) === 'eth');
  const untracked = moving.filter((l) => !tracked.includes(l));

  if (tracked.length === 0) {
    const internal = legs.some((l) => l.source_key !== 'gas' && isInternal(l, wallets));
    return internal
      ? { shape: 'internal', summary: 'Moved between your own wallets' }
      : { shape: 'gas', summary: 'Only the network fee' };
  }

  // A token Luca does not track going one way while a tracked asset goes the other way
  // (buying or selling something unknown): ask, do not guess.
  if (untracked.some((u) => tracked.some((t) => t.direction !== u.direction))) {
    return { shape: 'complex', summary: 'A token I do not track moved in the same transaction' };
  }

  const directions = new Set(tracked.map((l) => l.direction));
  if (directions.size === 1) return { shape: 'single', summary: '' };

  const net = new Map<string, { value: number; asset: string }>();
  for (const l of tracked) {
    const key = assetKey(l);
    const cur = net.get(key) ?? { value: 0, asset: key === 'eth' ? 'ETH' : (l.asset ?? 'token') };
    cur.value += l.direction === 'in' ? (l.amount ?? 0) : -(l.amount ?? 0);
    net.set(key, cur);
  }
  const scale = Math.max(...tracked.map((l) => l.amount ?? 0));
  const eps = scale * 1e-9;
  const gained = [...net.values()].filter((n) => n.value > eps);
  const spent = [...net.values()].filter((n) => n.value < -eps);

  if (gained.length === 1 && spent.length === 1) {
    return {
      shape: 'swap',
      summary: `Swapped ${fmt(spent[0].value)} ${spent[0].asset} for ${fmt(gained[0].value)} ${gained[0].asset}`,
    };
  }
  if (gained.length === 0 && spent.length === 0) {
    return { shape: 'swap', summary: 'Wrapped or unwrapped ETH' };
  }
  return { shape: 'complex', summary: 'Several assets moved in both directions' };
}
