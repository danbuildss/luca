import axios from 'axios';
import pRetry from 'p-retry';
import { logger } from '../logger.js';

export type AlchemyTransfer = {
  blockNum: string;         // hex block number
  uniqueId: string;         // "hash:logIndex" for erc20, "hash:external" for native
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

type JsonRpcResult<T> = { id: number; jsonrpc: '2.0'; result: T };
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
      return res.data.result;
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

// USDC on Base mainnet
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export async function getUsdcBalance(apiKey: string, walletAddress: string): Promise<number> {
  // ERC-20 balanceOf(address) selector: 0x70a08231
  const data = '0x70a08231' + walletAddress.slice(2).padStart(64, '0');
  const hex = await rpc<string>(apiKey, 'eth_call', [{ to: USDC_BASE, data }, 'latest']);
  // Returns 0x0 if wallet has no balance or token not held
  if (hex === '0x' || hex === '0x0') return 0;
  return Number(BigInt(hex)) / 1e6;
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
