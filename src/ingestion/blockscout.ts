import axios from 'axios';
import pRetry from 'p-retry';
import { logger } from '../logger.js';
import type { TxRow, EventRow } from './normalize.js';

const BASE_URL = 'https://base.blockscout.com/api/v2';

export type BlockscoutTokenTransfer = {
  block_number: number;
  from: { hash: string };
  to: { hash: string } | null;
  token: {
    address: string;
    decimals: string | null;
    symbol: string | null;
  };
  total: {
    decimals: string;
    value: string; // raw integer (not divided by decimals)
  };
  tx_hash: string;
  timestamp: string; // "2024-01-15T10:30:00.000000Z"
  log_index: string | null;
};

export type BlockscoutTx = {
  hash: string;
  block: number;
  timestamp: string;
  from: { hash: string };
  to: { hash: string } | null;
  value: string; // wei as string
  gas_used: string | null;
  gas_price: string | null;
  status: string;
};

type PagedResponse<T> = {
  items: T[];
  next_page_params: Record<string, unknown> | null;
};

async function get<T>(url: string): Promise<T> {
  return pRetry(
    async () => {
      const res = await axios.get<T>(url);
      return res.data;
    },
    {
      retries: 3,
      minTimeout: 1500,
      onFailedAttempt: (err) => {
        logger.warn({ url, attempt: err.attemptNumber, err: err.message }, 'Blockscout retry');
      },
    },
  );
}

function buildUrl(path: string, params: Record<string, unknown> = {}): string {
  const u = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// ---- Fetchers (raw Blockscout types, no wallet/user IDs) ----

export async function fetchTokenTransfers(
  walletAddress: string,
  fromBlockNumber: number,
): Promise<BlockscoutTokenTransfer[]> {
  const all: BlockscoutTokenTransfer[] = [];
  let nextParams: Record<string, unknown> | null = null;

  do {
    const url = buildUrl(`/addresses/${walletAddress}/token-transfers`, {
      type: 'ERC-20',
      ...(nextParams ?? {}),
    });

    const page = await get<PagedResponse<BlockscoutTokenTransfer>>(url);
    const relevant = page.items.filter((t) => t.block_number >= fromBlockNumber);
    all.push(...relevant);

    const oldest = page.items.at(-1);
    if (!oldest || oldest.block_number < fromBlockNumber) break;

    nextParams = page.next_page_params;
  } while (nextParams);

  return all;
}

export async function fetchNativeTransactions(
  walletAddress: string,
  fromBlockNumber: number,
): Promise<BlockscoutTx[]> {
  const all: BlockscoutTx[] = [];
  let nextParams: Record<string, unknown> | null = null;

  do {
    const url = buildUrl(`/addresses/${walletAddress}/transactions`, {
      filter: 'to | from',
      ...(nextParams ?? {}),
    });

    const page = await get<PagedResponse<BlockscoutTx>>(url);
    const relevant = page.items.filter((t) => t.block >= fromBlockNumber && t.value !== '0');
    all.push(...relevant);

    const oldest = page.items.at(-1);
    if (!oldest || oldest.block < fromBlockNumber) break;

    nextParams = page.next_page_params;
  } while (nextParams);

  return all;
}

// ---- Balance helpers ----

type AddressInfo = { coin_balance: string };
type TokenBalance = {
  token: { address: string; symbol: string | null; decimals: string | null };
  value: string;
};

export async function getEthBalanceBlockscout(walletAddress: string): Promise<number> {
  const info = await get<AddressInfo>(buildUrl(`/addresses/${walletAddress}`));
  return Number(BigInt(info.coin_balance)) / 1e18;
}

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export async function getUsdcBalanceBlockscout(walletAddress: string): Promise<number> {
  const balances = await get<TokenBalance[]>(
    buildUrl(`/addresses/${walletAddress}/token-balances`),
  );
  const usdc = balances.find(
    (b) => b.token.address.toLowerCase() === USDC_BASE.toLowerCase(),
  );
  if (!usdc) return 0;
  return Number(BigInt(usdc.value)) / 1e6;
}

// ---- Normalizers (same output shape as normalize.ts for Alchemy) ----

export function normalizeTokenTransfer(
  t: BlockscoutTokenTransfer,
  walletAddress: string,
  walletId: string,
  userId: string,
): { tx: TxRow; event: EventRow } {
  const direction: 'in' | 'out' =
    t.from.hash.toLowerCase() === walletAddress.toLowerCase() ? 'out' : 'in';

  const decimals = t.total.decimals ? parseInt(t.total.decimals, 10) : 18;
  const amount = Number(BigInt(t.total.value)) / 10 ** decimals;
  const logIndex = t.log_index !== null ? parseInt(t.log_index, 10) : null;
  const blockTime = new Date(t.timestamp);

  const tx: TxRow = {
    wallet_id: walletId,
    chain: 'base',
    hash: t.tx_hash,
    block_number: t.block_number,
    block_time: blockTime,
    from_address: t.from.hash,
    to_address: t.to?.hash ?? null,
    asset: t.token.symbol,
    amount,
    usd_value: null,
    gas_used: null,
    gas_price: null,
    gas_usd: null,
    direction,
    tx_type: 'transfer',
    raw_payload: t as unknown as Record<string, unknown>,
  };

  const event: EventRow = {
    wallet_id: walletId,
    user_id: userId,
    chain: 'base',
    hash: t.tx_hash,
    log_index: logIndex,
    block_time: blockTime,
    from_address: t.from.hash,
    to_address: t.to?.hash ?? null,
    asset: t.token.symbol,
    amount,
    usd_value: null,
    price_source: null,
    price_at: null,
    direction,
  };

  return { tx, event };
}

export function normalizeNativeTx(
  t: BlockscoutTx,
  walletAddress: string,
  walletId: string,
  userId: string,
): { tx: TxRow; event: EventRow } {
  const direction: 'in' | 'out' =
    t.from.hash.toLowerCase() === walletAddress.toLowerCase() ? 'out' : 'in';

  const amount = Number(BigInt(t.value)) / 1e18;
  const gasUsed = t.gas_used ? Number(t.gas_used) : null;
  const gasPrice = t.gas_price ? Number(BigInt(t.gas_price)) / 1e9 : null; // Gwei
  const blockTime = new Date(t.timestamp);

  const tx: TxRow = {
    wallet_id: walletId,
    chain: 'base',
    hash: t.hash,
    block_number: t.block,
    block_time: blockTime,
    from_address: t.from.hash,
    to_address: t.to?.hash ?? null,
    asset: 'ETH',
    amount,
    usd_value: null,
    gas_used: gasUsed,
    gas_price: gasPrice,
    gas_usd: null,
    direction,
    tx_type: 'transfer',
    raw_payload: t as unknown as Record<string, unknown>,
  };

  const event: EventRow = {
    wallet_id: walletId,
    user_id: userId,
    chain: 'base',
    hash: t.hash,
    log_index: null, // native ETH transfers don't have a log index
    block_time: blockTime,
    from_address: t.from.hash,
    to_address: t.to?.hash ?? null,
    asset: 'ETH',
    amount,
    usd_value: null,
    price_source: null,
    price_at: null,
    direction,
  };

  return { tx, event };
}
