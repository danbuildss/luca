import axios from 'axios';
import pRetry from 'p-retry';
import { logger } from '../logger.js';
import { buildSourceKey, parseIndex, toRawAmount } from './normalize.js';
import { identifyAsset, BASE_USDC, BASE_BNKR, SUPPORTED_TOKENS } from './assets.js';
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
  // API v2 calls it block_number; older Blockscout versions used block. Null while pending.
  block_number?: number | null;
  block?: number | null;
  timestamp: string;
  from: { hash: string };
  to: { hash: string } | null;
  value: string; // wei as string
  gas_used: string | null;
  gas_price: string | null;
  status: string | null;
};

// Block of a mined transaction. A mined transaction without one means the API changed
// shape: fail loudly rather than silently drop every transaction (and its gas).
export function minedBlock(t: BlockscoutTx): number {
  const b = t.block_number ?? t.block;
  if (typeof b !== 'number') throw new Error(`Blockscout transaction ${t.hash} has no block number`);
  return b;
}

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

function buildUrl(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): string {
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

// Only successful, value-bearing native txs are economic transfers. Failed/reverted
// (status 'error') and pending (status null) txs moved no ETH.
export function isIngestibleNativeTx(fromBlockNumber: number): (t: BlockscoutTx) => boolean {
  return (t) =>
    t.status === 'ok' &&
    minedBlock(t) >= fromBlockNumber &&
    Boolean(t.value) &&
    t.value !== '0';
}

export async function fetchNativeTransactions(
  walletAddress: string,
  fromBlockNumber: number,
): Promise<BlockscoutTx[]> {
  const all: BlockscoutTx[] = [];
  let nextParams: Record<string, unknown> | null = null;

  do {
    // No filter: Blockscout returns transactions in both directions. (The API accepts
    // only "to" or "from"; the literal "to | from" is rejected with HTTP 422.)
    // Blockscout's next_page_params are block numbers, indexes and hashes
    const url = buildUrl(`/addresses/${walletAddress}/transactions`, (nextParams ?? {}) as Record<string, string | number | null>);

    const page = await get<PagedResponse<BlockscoutTx>>(url);
    const relevant = page.items.filter(isIngestibleNativeTx(fromBlockNumber));
    all.push(...relevant);

    const oldest = page.items.filter((t) => t.status !== null).at(-1);
    if (!oldest || minedBlock(oldest) < fromBlockNumber) break;

    nextParams = page.next_page_params;
  } while (nextParams);

  return all;
}

// Every transaction the wallet sent in [fromBlock, toBlock], including failed ones: they
// cost gas even though no value moved. Pending transactions (status null) are skipped.
export async function fetchSentTransactions(
  walletAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<BlockscoutTx[]> {
  const all: BlockscoutTx[] = [];
  let nextParams: Record<string, unknown> | null = null;
  const wallet = walletAddress.toLowerCase();

  do {
    const url = buildUrl(`/addresses/${walletAddress}/transactions`, {
      filter: 'from',
      ...(nextParams ?? {}),
    });

    const page = await get<PagedResponse<BlockscoutTx>>(url);
    const mined = page.items.filter((t) => t.status !== null);
    all.push(...mined.filter((t) => {
      const block = minedBlock(t);
      return block >= fromBlock && block <= toBlock && t.from.hash.toLowerCase() === wallet;
    }));

    const oldest = mined.at(-1);
    if (!oldest || minedBlock(oldest) < fromBlock) break;

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

export async function getTokenBalancesBlockscout(
  walletAddress: string,
): Promise<{ usdc: number; bnkr: number }> {
  const balances = await get<TokenBalance[]>(
    buildUrl(`/addresses/${walletAddress}/token-balances`),
  );
  const balanceOf = (contract: string): number => {
    const row = balances.find((b) => b.token.address.toLowerCase() === contract);
    if (!row) return 0;
    return Number(BigInt(row.value)) / 10 ** SUPPORTED_TOKENS[contract].decimals;
  };
  return { usdc: balanceOf(BASE_USDC), bnkr: balanceOf(BASE_BNKR) };
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
  const logIndex =
    t.log_index !== null && t.log_index !== undefined ? parseIndex(String(t.log_index)) : null;
  const blockTime = new Date(t.timestamp);
  const sourceKey = buildSourceKey({
    kind: logIndex !== null ? 'log' : 'unknown',
    logIndex,
    from: t.from.hash,
    to: t.to?.hash ?? null,
    rawValue: t.total.value,
  });
  const identity = identifyAsset({ native: false, tokenAddress: t.token.address, providerSymbol: t.token.symbol });

  const tx: TxRow = {
    wallet_id: walletId,
    chain: 'base',
    hash: t.tx_hash,
    block_number: t.block_number,
    block_time: blockTime,
    from_address: t.from.hash,
    to_address: t.to?.hash ?? null,
    asset: identity.symbol,
    amount,
    usd_value: null,
    gas_used: null,
    gas_price: null,
    gas_usd: null,
    direction,
    tx_type: 'transfer',
    raw_payload: t,
  };

  const event: EventRow = {
    wallet_id: walletId,
    user_id: userId,
    chain: 'base',
    hash: t.tx_hash,
    log_index: logIndex,
    source_key: sourceKey,
    token_address: identity.tokenAddress,
    supported: identity.supported,
    raw_amount: toRawAmount(t.total.value),
    block_number: t.block_number,
    category: 'erc20',
    block_time: blockTime,
    from_address: t.from.hash,
    to_address: t.to?.hash ?? null,
    asset: identity.symbol,
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
    block_number: minedBlock(t),
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
    raw_payload: t,
  };

  const event: EventRow = {
    wallet_id: walletId,
    user_id: userId,
    chain: 'base',
    hash: t.hash,
    log_index: null, // native ETH transfers don't have a log index
    source_key: 'external', // one top-level native transfer per tx — matches Alchemy's key
    token_address: null,
    supported: true,
    raw_amount: toRawAmount(t.value),
    block_number: minedBlock(t),
    category: 'external',
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
