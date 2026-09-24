import type { AlchemyTransfer } from './alchemy.js';
import { identifyAsset } from './assets.js';

export type TxRow = {
  wallet_id: string;
  chain: string;
  hash: string;
  block_number: number;
  block_time: Date;
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: number | null;
  usd_value: number | null;
  gas_used: number | null;
  gas_price: number | null;
  gas_usd: number | null;
  direction: 'in' | 'out';
  tx_type: 'transfer' | 'swap' | 'contract_call' | 'internal';
  raw_payload: Record<string, unknown>;
};

export type EventRow = {
  wallet_id: string;
  user_id: string;
  chain: string;
  hash: string;
  log_index: number | null;
  // Stable per-transfer discriminator within (chain, hash, wallet_id) — see buildSourceKey
  source_key: string;
  // Lowercase token contract; null for native ETH
  token_address: string | null;
  // ETH, USDC or BNKR by identity (see assets.ts); other tokens are stored but never shown
  supported: boolean;
  // Exact integer amount in the asset's smallest unit (wei), as a decimal string
  raw_amount: string | null;
  block_number: number;
  // How the transfer was observed; 'gas' marks a fee paid by the wallet
  category: 'external' | 'internal' | 'erc20' | 'log' | 'gas';
  block_time: Date;
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: number | null;
  usd_value: number | null;
  price_source: string | null;
  price_at: Date | null;
  // Where the USD value came from, in words (set when priced)
  price_ref?: string | null;
  direction: 'in' | 'out';
};

// Parse a non-negative integer written as hex ("0x1f") or decimal ("31").
export function parseIndex(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  return null;
}

export type ParsedUniqueId = {
  kind: 'log' | 'external' | 'internal' | 'unknown';
  index: number | null;
};

// Alchemy uniqueId formats seen / tolerated:
//   "<hash>:log:<n>"        ERC-20 (n hex or decimal)
//   "<hash>:<n>"            ERC-20, legacy/short form (n hex "0x0a" or decimal)
//   "<hash>:external"       native top-level transfer
//   "<hash>:internal"       internal transfer
//   "<hash>:internal:<n>"   internal transfer with trace position
export function parseUniqueId(uniqueId: string): ParsedUniqueId {
  const parts = (uniqueId ?? '').split(':');
  const tag = parts[1]?.trim().toLowerCase();
  if (!tag) return { kind: 'unknown', index: null };
  if (tag === 'log') return { kind: 'log', index: parseIndex(parts[2]) };
  if (tag === 'external') return { kind: 'external', index: parseIndex(parts[2]) };
  if (tag === 'internal') return { kind: 'internal', index: parseIndex(parts[2]) };
  const idx = parseIndex(tag);
  return idx === null ? { kind: 'unknown', index: null } : { kind: 'log', index: idx };
}

export function parseLogIndex(uniqueId: string): number | null {
  const parsed = parseUniqueId(uniqueId);
  return parsed.kind === 'log' ? parsed.index : null;
}

// Stable per-transfer discriminator within (chain, hash, wallet_id).
// Must be identical across providers and re-syncs for the same transfer.
export function buildSourceKey(params: {
  kind: 'log' | 'external' | 'internal' | 'unknown';
  logIndex: number | null;
  internalIndex?: number | null;
  from: string;
  to: string | null;
  rawValue: string | number | null;
  uniqueId?: string;
}): string {
  if (params.logIndex !== null) return `log:${params.logIndex}`;
  if (params.kind === 'external') return 'external';
  const fingerprint = [
    params.from.toLowerCase(),
    (params.to ?? '').toLowerCase(),
    String(params.rawValue ?? '').toLowerCase(),
  ].join(':');
  if (params.kind === 'internal') {
    return params.internalIndex !== null && params.internalIndex !== undefined
      ? `internal:${params.internalIndex}`
      : `internal:${fingerprint}`;
  }
  // Token transfer without a log index, or unrecognised uniqueId
  return params.uniqueId ? `uid:${params.uniqueId.toLowerCase()}` : `transfer:${fingerprint}`;
}

function toTxType(category: AlchemyTransfer['category']): TxRow['tx_type'] {
  if (category === 'internal') return 'internal';
  return 'transfer';
}

// Alchemy/Blockscout raw values: hex ("0x1dcd6500") or decimal strings
export function toRawAmount(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return BigInt(value).toString();
  } catch {
    return null;
  }
}

export function normalizeTransfer(
  t: AlchemyTransfer,
  walletAddress: string,
  walletId: string,
  userId: string,
): { tx: TxRow; event: EventRow } {
  const direction: 'in' | 'out' =
    t.from.toLowerCase() === walletAddress.toLowerCase() ? 'out' : 'in';

  const blockTime = new Date(t.metadata.blockTimestamp);
  const blockNumber = parseInt(t.blockNum, 16);

  const parsedId = parseUniqueId(t.uniqueId);
  const logIndex =
    t.category === 'external' || t.category === 'internal' ? null : parseLogIndex(t.uniqueId);
  const sourceKey = buildSourceKey({
    kind:
      t.category === 'external' ? 'external'
      : t.category === 'internal' ? 'internal'
      : logIndex !== null ? 'log'
      : 'unknown',
    logIndex,
    internalIndex: parsedId.kind === 'internal' ? parsedId.index : null,
    from: t.from,
    to: t.to,
    rawValue: t.rawContract?.value ?? t.value,
    uniqueId: t.uniqueId,
  });
  const identity = identifyAsset({
    native: t.category === 'external' || t.category === 'internal',
    tokenAddress: t.rawContract?.address,
    providerSymbol: t.asset,
  });

  const tx: TxRow = {
    wallet_id: walletId,
    chain: 'base',
    hash: t.hash,
    block_number: blockNumber,
    block_time: blockTime,
    from_address: t.from,
    to_address: t.to,
    asset: identity.symbol,
    amount: t.value,
    usd_value: null,
    gas_used: null,
    gas_price: null,
    gas_usd: null,
    direction,
    tx_type: toTxType(t.category),
    raw_payload: t as unknown as Record<string, unknown>,
  };

  const event: EventRow = {
    wallet_id: walletId,
    user_id: userId,
    chain: 'base',
    hash: t.hash,
    log_index: logIndex,
    source_key: sourceKey,
    token_address: identity.tokenAddress,
    supported: identity.supported,
    raw_amount: toRawAmount(t.rawContract?.value),
    block_number: blockNumber,
    category: t.category === 'specialnft' ? 'erc20' : t.category,
    block_time: blockTime,
    from_address: t.from,
    to_address: t.to,
    asset: identity.symbol,
    amount: t.value,
    usd_value: null,
    price_source: null,
    price_at: null,
    direction,
  };

  return { tx, event };
}
