import axios from 'axios';
import pRetry, { AbortError } from 'p-retry';
import { logger } from '../logger.js';

export type AlchemyTransfer = {
  blockNum: string;         // hex block number
  uniqueId: string;         // e.g. "hash:log:5" for erc20, "hash:external" / "hash:internal[:n]" for native — see parseUniqueId
  hash: string;
  from: string;
  to: string | null;
  value: number | null;     // human-readable amount (divided by decimals)
  asset: string | null;     // token symbol e.g. "USDC", "ETH"
  category: 'external' | 'internal' | 'erc20' | 'specialnft';
  metadata: { blockTimestamp: string };
  rawContract: {
    value: string | null;   // hex raw amount
    address: string | null; // token contract; null for native ETH
    decimal: string | null; // hex decimals
  };
};

type JsonRpcResult<T> = {
  id: number;
  jsonrpc: '2.0';
  result?: T;
  error?: { code: number; message: string };
};

// A JSON-RPC error (bad params, range too large…) is deterministic: fail fast instead of
// retrying, and never hand `undefined` back as if it were a result.
export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string) {
    super(`${method}: ${message}`);
  }
}
type TransfersResult = { transfers: AlchemyTransfer[]; pageKey?: string };

function rpcUrl(apiKey: string): string {
  return `https://base-mainnet.g.alchemy.com/v2/${apiKey}`;
}

async function rpc<T>(apiKey: string, method: string, params: unknown[]): Promise<T> {
  return pRetry(
    async () => {
      const res = await axios.post<JsonRpcResult<T>>(rpcUrl(apiKey), {
        id: 1,
        jsonrpc: '2.0',
        method,
        params,
      });
      if (res.data.error) {
        throw new AbortError(new RpcError(method, res.data.error.code, res.data.error.message));
      }
      return res.data.result as T;
    },
    {
      retries: 3,
      minTimeout: 1000,
      onFailedAttempt: (err) => {
        logger.warn({ method, attempt: err.attemptNumber, err: err.message }, 'Alchemy RPC retry');
      },
    },
  );
}

async function fetchPage(
  apiKey: string,
  params: Record<string, unknown>,
  pageKey?: string,
): Promise<TransfersResult> {
  return rpc<TransfersResult>(apiKey, 'alchemy_getAssetTransfers', [
    { ...params, ...(pageKey ? { pageKey } : {}) },
  ]);
}

export async function fetchAllTransfers(
  apiKey: string,
  walletAddress: string,
  fromBlock: string,
  toBlock = 'latest',
): Promise<AlchemyTransfer[]> {
  const base = {
    fromBlock,
    toBlock,
    category: ['external', 'internal', 'erc20'],
    withMetadata: true,
    excludeZeroValue: true,
    maxCount: '0x3e8', // 1000 per page
  };

  const all: AlchemyTransfer[] = [];

  // Outgoing: transfers FROM this wallet
  let outKey: string | undefined;
  do {
    const page = await fetchPage(apiKey, { ...base, fromAddress: walletAddress }, outKey);
    all.push(...page.transfers);
    outKey = page.pageKey;
  } while (outKey);

  // Incoming: transfers TO this wallet
  let inKey: string | undefined;
  do {
    const page = await fetchPage(apiKey, { ...base, toAddress: walletAddress }, inKey);
    all.push(...page.transfers);
    inKey = page.pageKey;
  } while (inKey);

  logger.debug({ wallet: walletAddress, count: all.length, fromBlock, toBlock }, 'Fetched transfers');
  return all;
}

export async function getCurrentBlock(apiKey: string): Promise<number> {
  const hex = await rpc<string>(apiKey, 'eth_blockNumber', []);
  return parseInt(hex, 16);
}

export async function getEthBalance(apiKey: string, walletAddress: string): Promise<number> {
  const hex = await rpc<string>(apiKey, 'eth_getBalance', [walletAddress, 'latest']);
  return Number(BigInt(hex)) / 1e18;
}

export async function getErc20Balance(
  apiKey: string,
  walletAddress: string,
  contract: string,
  decimals: number,
): Promise<number> {
  // ERC-20 balanceOf(address) selector: 0x70a08231
  const data = '0x70a08231' + walletAddress.slice(2).padStart(64, '0');
  const hex = await rpc<string>(apiKey, 'eth_call', [{ to: contract, data }, 'latest']);
  // Returns 0x0 if wallet has no balance or token not held
  if (hex === '0x' || hex === '0x0') return 0;
  return Number(BigInt(hex)) / 10 ** decimals;
}

// Blocks per 30 days on Base (~2s block time)
export const BLOCKS_30_DAYS = 30 * 24 * 60 * 60 / 2; // 1_296_000

export function backfillFromBlock(currentBlock: number): string {
  const from = Math.max(0, currentBlock - BLOCKS_30_DAYS);
  return '0x' + from.toString(16);
}

export function blockToHex(block: number): string {
  return '0x' + block.toString(16);
}

// ---------------------------------------------------------------------------
// Receipts, logs, blocks and balances at a block (archive reads)
// ---------------------------------------------------------------------------

function big(hex: string | null | undefined): bigint {
  return hex ? BigInt(hex) : 0n;
}

type RpcReceipt = {
  transactionHash: string;
  blockNumber: string;
  blockHash: string | null;
  status: string | null;
  from: string;
  to: string | null;
  gasUsed: string;
  effectiveGasPrice?: string | null;
  // OP Stack (Base) fields
  l1Fee?: string | null;
  operatorFeeScalar?: string | null;
  operatorFeeConstant?: string | null;
};

export type TxReceipt = {
  hash: string;
  blockNumber: number;
  blockHash: string | null;
  status: 'success' | 'failed';
  from: string;
  to: string | null;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  l1Fee: bigint;
  operatorFee: bigint;
  // Everything the sender paid in ETH for this transaction
  fee: bigint;
  raw: Record<string, unknown>;
};

// Base fee = L2 execution (gasUsed × effectiveGasPrice) + L1 data fee
// + operator fee (OP Isthmus: gasUsed × scalar / 1e6 + constant; zero when absent).
export function parseReceipt(r: RpcReceipt): TxReceipt {
  const gasUsed = big(r.gasUsed);
  const effectiveGasPrice = big(r.effectiveGasPrice);
  const l1Fee = big(r.l1Fee);
  const operatorFee = r.operatorFeeScalar != null || r.operatorFeeConstant != null
    ? (gasUsed * big(r.operatorFeeScalar)) / 1_000_000n + big(r.operatorFeeConstant)
    : 0n;
  return {
    hash: r.transactionHash,
    blockNumber: parseInt(r.blockNumber, 16),
    blockHash: r.blockHash,
    status: r.status === '0x1' ? 'success' : 'failed',
    from: r.from,
    to: r.to,
    gasUsed,
    effectiveGasPrice,
    l1Fee,
    operatorFee,
    fee: gasUsed * effectiveGasPrice + l1Fee + operatorFee,
    raw: r,
  };
}

export async function getTransactionReceipt(apiKey: string, hash: string): Promise<TxReceipt | null> {
  const r = await rpc<RpcReceipt | null>(apiKey, 'eth_getTransactionReceipt', [hash]);
  return r ? parseReceipt(r) : null;
}

// The transaction itself: who sent it, to whom, and the ETH it carried at the top level.
export type ChainTx = { hash: string; from: string; to: string | null; value: bigint; blockNumber: number | null };

export async function getTransaction(apiKey: string, hash: string): Promise<ChainTx | null> {
  const t = await rpc<{ hash: string; from: string; to: string | null; value: string; blockNumber: string | null } | null>(
    apiKey, 'eth_getTransactionByHash', [hash],
  );
  if (!t) return null;
  return {
    hash: t.hash,
    from: t.from,
    to: t.to,
    value: big(t.value),
    blockNumber: t.blockNumber ? parseInt(t.blockNumber, 16) : null,
  };
}

export type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
};

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export function addressTopic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

// eth_getLogs over [fromBlock, toBlock] in chunks; a chunk the provider rejects is halved.
export async function getLogsChunked(
  apiKey: string,
  filter: { address: string[]; topics: Array<string | null> },
  fromBlock: number,
  toBlock: number,
  chunk = 2_000,
): Promise<RpcLog[]> {
  const out: RpcLog[] = [];
  let start = fromBlock;
  let size = chunk;
  while (start <= toBlock) {
    const end = Math.min(toBlock, start + size - 1);
    try {
      const logs = await rpc<RpcLog[]>(apiKey, 'eth_getLogs', [{
        address: filter.address,
        topics: filter.topics,
        fromBlock: blockToHex(start),
        toBlock: blockToHex(end),
      }]);
      out.push(...logs.filter((l) => !l.removed));
      start = end + 1;
      size = chunk;
    } catch (err) {
      if (!(err instanceof RpcError) || size <= 1) throw err;
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  return out;
}

export type BlockInfo = {
  number: number;
  timestamp: number; // unix seconds
  transactions: Array<{ hash: string; from: string; to: string | null }>;
};

export async function getBlock(apiKey: string, blockNumber: number, withTransactions = false): Promise<BlockInfo | null> {
  const b = await rpc<{
    number: string;
    timestamp: string;
    transactions: Array<string | { hash: string; from: string; to: string | null }>;
  } | null>(apiKey, 'eth_getBlockByNumber', [blockToHex(blockNumber), withTransactions]);
  if (!b) return null;
  return {
    number: parseInt(b.number, 16),
    timestamp: parseInt(b.timestamp, 16),
    transactions: withTransactions
      ? (b.transactions as Array<{ hash: string; from: string; to: string | null }>)
      : [],
  };
}

// A read-only contract call at a block (or the latest one). Reverts throw RpcError.
export async function ethCall(apiKey: string, to: string, data: string, block: number | 'latest'): Promise<string> {
  return rpc<string>(apiKey, 'eth_call', [{ to, data }, block === 'latest' ? 'latest' : blockToHex(block)]);
}

export async function getEthBalanceAt(apiKey: string, walletAddress: string, blockNumber: number): Promise<bigint> {
  return big(await rpc<string>(apiKey, 'eth_getBalance', [walletAddress, blockToHex(blockNumber)]));
}

export async function getErc20BalanceAt(
  apiKey: string,
  walletAddress: string,
  contract: string,
  blockNumber: number,
): Promise<bigint> {
  const data = '0x70a08231' + walletAddress.slice(2).toLowerCase().padStart(64, '0');
  const hex = await rpc<string>(apiKey, 'eth_call', [{ to: contract, data }, blockToHex(blockNumber)]);
  return hex === '0x' ? 0n : big(hex);
}

