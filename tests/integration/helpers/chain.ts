// A simulated Base chain for ingestion and balance-check tests.
//
// `truth` is what actually happened on chain (it drives balances at any block). What each
// provider reports is configured separately, so a test can make the transfer feed, the
// token logs or the sent-transaction list miss something and check how Luca copes.
import type { AlchemyTransfer, RpcLog, parseReceipt as ParseReceipt } from '../../../src/ingestion/alchemy.js';
import type { BlockscoutTx } from '../../../src/ingestion/blockscout.js';

export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TS0 = 1_790_000_000;

type RpcReceipt = Parameters<typeof ParseReceipt>[0];
type Truth = { block: number; token: string | null; wallet: string; delta: bigint };

export const chain = {
  tip: 1000,
  feed: [] as AlchemyTransfer[],
  logs: [] as RpcLog[],
  sent: [] as BlockscoutTx[],
  receipts: new Map<string, RpcReceipt>(),
  blockTxs: new Map<number, Array<{ hash: string; from: string; to: string | null }>>(),
  truth: [] as Truth[],
  feedDown: false,
};

let seq = 0;
function hash(): string {
  seq++;
  return `0x${seq.toString(16).padStart(64, 'c')}`;
}
const hex = (n: bigint | number): string => `0x${n.toString(16)}`;
const topic = (a: string): string => `0x${a.toLowerCase().slice(2).padStart(64, '0')}`;
const time = (block: number): string => new Date((TS0 + block) * 1000).toISOString();

export function resetChain(): void {
  chain.tip = 1000;
  chain.feed = [];
  chain.logs = [];
  chain.sent = [];
  chain.receipts = new Map();
  chain.blockTxs = new Map();
  chain.truth = [];
  chain.feedDown = false;
}

export function balanceAt(wallet: string, token: string | null, block: number): bigint {
  return chain.truth
    .filter((t) => t.wallet === wallet.toLowerCase() && t.token === token && t.block <= block)
    .reduce((sum, t) => sum + t.delta, 0n);
}

function move(wallet: string, token: string | null, block: number, from: string, to: string, raw: bigint): void {
  const w = wallet.toLowerCase();
  if (to.toLowerCase() === w) chain.truth.push({ block, token, wallet: w, delta: raw });
  if (from.toLowerCase() === w) chain.truth.push({ block, token, wallet: w, delta: -raw });
}

// A USDC transfer. inFeed / inLogs control which sources report it.
export function usdcTransfer(wallet: string, o: {
  block: number; from: string; to: string; raw: bigint; inFeed?: boolean; inLogs?: boolean; txHash?: string; logIndex?: number;
}): string {
  const h = o.txHash ?? hash();
  const logIndex = o.logIndex ?? 1;
  move(wallet, USDC, o.block, o.from, o.to, o.raw);
  if (o.inFeed ?? true) {
    chain.feed.push({
      blockNum: hex(o.block), uniqueId: `${h}:log:${logIndex}`, hash: h,
      from: o.from, to: o.to, value: Number(o.raw) / 1e6, asset: 'USDC', category: 'erc20',
      metadata: { blockTimestamp: time(o.block) },
      rawContract: { value: hex(o.raw), address: USDC, decimal: '0x6' },
    });
  }
  if (o.inLogs ?? true) {
    chain.logs.push({
      address: USDC, topics: [TRANSFER_TOPIC, topic(o.from), topic(o.to)], data: hex(o.raw),
      blockNumber: hex(o.block), blockHash: `0xb${o.block}`, transactionHash: h, logIndex: hex(logIndex),
    });
  }
  return h;
}

// A spam token transfer: reported by the feed, never part of the ledger.
export function spamTransfer(wallet: string, o: { block: number; from: string; raw: bigint; symbol?: string }): string {
  const h = hash();
  chain.feed.push({
    blockNum: hex(o.block), uniqueId: `${h}:log:3`, hash: h, from: o.from, to: wallet,
    value: Number(o.raw), asset: o.symbol ?? 'USDC', category: 'erc20',
    metadata: { blockTimestamp: time(o.block) },
    rawContract: { value: hex(o.raw), address: '0x1111111111111111111111111111111111111111', decimal: '0x0' },
  });
  return h;
}

// Native ETH moving in or out. category 'internal' = received from a contract call.
export function ethTransfer(wallet: string, o: {
  block: number; from: string; to: string; wei: bigint; category?: 'external' | 'internal'; inFeed?: boolean; txHash?: string;
}): string {
  const h = o.txHash ?? hash();
  const category = o.category ?? 'external';
  move(wallet, null, o.block, o.from, o.to, o.wei);
  if (o.inFeed ?? true) {
    chain.feed.push({
      blockNum: hex(o.block), uniqueId: category === 'external' ? `${h}:external` : `${h}:internal:0`, hash: h,
      from: o.from, to: o.to, value: Number(o.wei) / 1e18, asset: 'ETH', category,
      metadata: { blockTimestamp: time(o.block) },
      rawContract: { value: hex(o.wei), address: null, decimal: '0x12' },
    });
  }
  return h;
}

// A transaction the wallet sent: its fee always leaves the wallet, success or not.
export function sentTx(wallet: string, o: {
  block: number; to?: string; gasUsed?: bigint; gasPrice?: bigint; l1Fee?: bigint;
  status?: 'success' | 'failed'; inBlockscout?: boolean; txHash?: string;
}): { hash: string; fee: bigint } {
  const h = o.txHash ?? hash();
  const gasUsed = o.gasUsed ?? 21_000n;
  const gasPrice = o.gasPrice ?? 1_000_000n;
  const l1Fee = o.l1Fee ?? 0n;
  const fee = gasUsed * gasPrice + l1Fee;
  const to = o.to ?? '0x2222222222222222222222222222222222222222';
  chain.truth.push({ block: o.block, token: null, wallet: wallet.toLowerCase(), delta: -fee });
  chain.receipts.set(h, {
    transactionHash: h, blockNumber: hex(o.block), blockHash: `0xb${o.block}`,
    status: (o.status ?? 'success') === 'success' ? '0x1' : '0x0',
    from: wallet, to, gasUsed: hex(gasUsed), effectiveGasPrice: hex(gasPrice), l1Fee: hex(l1Fee),
  });
  const txs = chain.blockTxs.get(o.block) ?? [];
  txs.push({ hash: h, from: wallet, to });
  chain.blockTxs.set(o.block, txs);
  if (o.inBlockscout ?? true) {
    chain.sent.push({
      hash: h, block_number: o.block, timestamp: time(o.block), from: { hash: wallet }, to: { hash: to },
      value: '0', gas_used: gasUsed.toString(), gas_price: gasPrice.toString(),
      status: (o.status ?? 'success') === 'success' ? 'ok' : 'error',
    });
  }
  return { hash: h, fee };
}

function involves(t: AlchemyTransfer, wallet: string): boolean {
  const w = wallet.toLowerCase();
  return t.from.toLowerCase() === w || (t.to ?? '').toLowerCase() === w;
}

// Module factories for vi.mock — wire the simulation into the real ingestion code.
export function alchemyMock<T extends Record<string, unknown>>(orig: T): T {
  const parseReceipt = orig.parseReceipt as typeof ParseReceipt;
  return {
    ...orig,
    getCurrentBlock: () => Promise.resolve(chain.tip),
    fetchAllTransfers: (_k: string, wallet: string, fromHex: string, toHex: string) => {
      if (chain.feedDown) return Promise.reject(new Error('alchemy transfers down'));
      const from = parseInt(fromHex, 16);
      const to = parseInt(toHex, 16);
      const w = wallet.toLowerCase();
      return Promise.resolve(chain.feed.filter((t) => {
        const b = parseInt(t.blockNum, 16);
        return b >= from && b <= to && (t.from.toLowerCase() === w || (t.to ?? '').toLowerCase() === w);
      }));
    },
    getLogsChunked: (_k: string, filter: { address: string[]; topics: Array<string | null> }, from: number, to: number) =>
      Promise.resolve(chain.logs.filter((l) => {
        const b = parseInt(l.blockNumber, 16);
        return b >= from && b <= to
          && filter.address.includes(l.address)
          && filter.topics.every((t, i) => t === null || l.topics[i] === t);
      })),
    getTransactionReceipt: (_k: string, h: string) => {
      const r = chain.receipts.get(h);
      return Promise.resolve(r ? parseReceipt(r) : null);
    },
    getBlock: (_k: string, n: number) =>
      Promise.resolve({ number: n, timestamp: TS0 + n, transactions: chain.blockTxs.get(n) ?? [] }),
    getEthBalanceAt: (_k: string, wallet: string, b: number) => Promise.resolve(balanceAt(wallet, null, b)),
    getErc20BalanceAt: (_k: string, wallet: string, token: string, b: number) =>
      Promise.resolve(balanceAt(wallet, token.toLowerCase(), b)),
    getEthBalance: () => Promise.resolve(0),
    getErc20Balance: () => Promise.resolve(0),
  } as T;
}

// Blockscout's HTTP API as seen by axios.get, in the real API v2 shape (newest first,
// block_number, pending transactions without a block), so the real fetchers are exercised.
export function blockscoutHttp(url: string): Promise<{ data: unknown }> {
  const u = new URL(url);
  const m = /^\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})\/transactions$/.exec(u.pathname);
  if (!m || u.searchParams.get('filter') !== 'from') return Promise.reject(new Error(`unexpected Blockscout call ${url}`));
  const wallet = m[1].toLowerCase();
  const mined = chain.sent
    .filter((t) => t.from.hash.toLowerCase() === wallet)
    .sort((a, b) => (b.block_number ?? 0) - (a.block_number ?? 0));
  const pending = { ...mined[0], hash: '0xpending', block_number: null, status: null };
  return Promise.resolve({ data: { items: mined.length ? [pending, ...mined] : [], next_page_params: null } });
}

export function blockscoutMock<T extends Record<string, unknown>>(orig: T): T {
  return {
    ...orig,
    // Fallback provider: sees token transfers and top-level ETH but, like the real
    // Blockscout fallback, no ETH received from contracts (internal transfers).
    fetchTokenTransfers: (wallet: string, from: number) => Promise.resolve(
      chain.feed
        .filter((t) => t.category === 'erc20' && parseInt(t.blockNum, 16) >= from && involves(t, wallet))
        .map((t) => ({
          block_number: parseInt(t.blockNum, 16),
          from: { hash: t.from },
          to: t.to ? { hash: t.to } : null,
          token: { address: t.rawContract.address ?? '', decimals: String(parseInt(t.rawContract.decimal ?? '0x0', 16)), symbol: t.asset },
          total: { decimals: String(parseInt(t.rawContract.decimal ?? '0x0', 16)), value: BigInt(t.rawContract.value ?? '0x0').toString() },
          tx_hash: t.hash,
          timestamp: t.metadata.blockTimestamp,
          log_index: t.uniqueId.split(':').at(-1) ?? null,
        }))),
    fetchNativeTransactions: (wallet: string, from: number) => Promise.resolve(
      chain.feed
        .filter((t) => t.category === 'external' && parseInt(t.blockNum, 16) >= from && involves(t, wallet))
        .map((t) => ({
          hash: t.hash, block_number: parseInt(t.blockNum, 16), timestamp: t.metadata.blockTimestamp,
          from: { hash: t.from }, to: t.to ? { hash: t.to } : null,
          value: BigInt(t.rawContract.value ?? '0x0').toString(), gas_used: null, gas_price: null, status: 'ok',
        }))),
  } as T;
}
