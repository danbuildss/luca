import { getLogsChunked, addressTopic, TRANSFER_TOPIC, type RpcLog } from './alchemy.js';
import { BASE_USDC, BASE_BNKR, SUPPORTED_TOKENS } from './assets.js';
import type { TxRow, EventRow } from './normalize.js';

export type TokenLog = {
  hash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  token: string; // lowercase contract
  from: string;
  to: string;
  raw: bigint;
  log: RpcLog;
};

function topicAddress(topic: string): string {
  return '0x' + topic.slice(-40).toLowerCase();
}

// Transfer logs of the supported tokens (USDC, BNKR) where the wallet is sender or receiver.
// This reads the token contracts directly, independent of Alchemy's transfer index.
export async function fetchSupportedTokenLogs(
  apiKey: string,
  walletAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<TokenLog[]> {
  const tokens = [BASE_USDC, BASE_BNKR];
  const wallet = addressTopic(walletAddress);
  const [sent, received] = await Promise.all([
    getLogsChunked(apiKey, { address: tokens, topics: [TRANSFER_TOPIC, wallet] }, fromBlock, toBlock),
    getLogsChunked(apiKey, { address: tokens, topics: [TRANSFER_TOPIC, null, wallet] }, fromBlock, toBlock),
  ]);

  const byKey = new Map<string, TokenLog>();
  for (const log of [...sent, ...received]) {
    // ERC-20 Transfer: topics = [sig, from, to], data = value. Anything else is not a transfer.
    if (log.topics.length !== 3) continue;
    const logIndex = parseInt(log.logIndex, 16);
    const key = `${log.transactionHash.toLowerCase()}:${logIndex}`;
    byKey.set(key, {
      hash: log.transactionHash,
      logIndex,
      blockNumber: parseInt(log.blockNumber, 16),
      blockHash: log.blockHash,
      token: log.address.toLowerCase(),
      from: topicAddress(log.topics[1]),
      to: topicAddress(log.topics[2]),
      raw: log.data && log.data !== '0x' ? BigInt(log.data) : 0n,
      log,
    });
  }
  return [...byKey.values()];
}

// Same shape as the Alchemy/Blockscout normalizers, with the same source_key (log:N), so a
// transfer seen by both collapses to one row.
export function normalizeTokenLog(
  l: TokenLog,
  walletAddress: string,
  blockTime: Date,
): { tx: TxRow; event: EventRow } {
  const info = SUPPORTED_TOKENS[l.token];
  const amount = Number(l.raw) / 10 ** info.decimals;
  const direction: 'in' | 'out' = l.from === walletAddress.toLowerCase() ? 'out' : 'in';
  const raw = l.log as unknown as Record<string, unknown>;

  return {
    tx: {
      wallet_id: '',
      chain: 'base',
      hash: l.hash,
      block_number: l.blockNumber,
      block_time: blockTime,
      from_address: l.from,
      to_address: l.to,
      asset: info.symbol,
      amount,
      usd_value: null,
      gas_used: null,
      gas_price: null,
      gas_usd: null,
      direction,
      tx_type: 'transfer',
      raw_payload: raw,
    },
    event: {
      wallet_id: '',
      user_id: '',
      chain: 'base',
      hash: l.hash,
      log_index: l.logIndex,
      source_key: `log:${l.logIndex}`,
      token_address: l.token,
      supported: true,
      raw_amount: l.raw.toString(),
      block_number: l.blockNumber,
      category: 'log',
      block_time: blockTime,
      from_address: l.from,
      to_address: l.to,
      asset: info.symbol,
      amount,
      usd_value: null,
      price_source: null,
      price_at: null,
      direction,
    },
  };
}
