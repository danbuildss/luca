import type { AlchemyTransfer } from './alchemy.js';

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
  block_time: Date;
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: number | null;
  usd_value: number | null;
  price_source: string | null;
  price_at: Date | null;
  direction: 'in' | 'out';
};

export function parseLogIndex(uniqueId: string): number | null {
  const parts = uniqueId.split(':');
  const suffix = parts[1];
  if (!suffix || suffix === 'external' || suffix === 'internal') return null;
  const parsed = parseInt(suffix, 16);
  return isNaN(parsed) ? null : parsed;
}

function toTxType(category: AlchemyTransfer['category']): TxRow['tx_type'] {
  if (category === 'internal') return 'internal';
  return 'transfer';
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

  const tx: TxRow = {
    wallet_id: walletId,
    chain: 'base',
    hash: t.hash,
    block_number: blockNumber,
    block_time: blockTime,
    from_address: t.from,
    to_address: t.to,
    asset: t.asset,
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
    log_index: parseLogIndex(t.uniqueId),
    block_time: blockTime,
    from_address: t.from,
    to_address: t.to,
    asset: t.asset,
    amount: t.value,
    usd_value: null,
    price_source: null,
    price_at: null,
    direction,
  };

  return { tx, event };
}
