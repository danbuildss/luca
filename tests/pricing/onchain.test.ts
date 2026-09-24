import { describe, it, expect, vi, beforeEach } from 'vitest';

// A simulated Base node answering eth_call for the Chainlink feeds and the BNKR/WETH pool
type Call = { to: string; data: string; block: string };
const calls: Call[] = [];
const node = vi.hoisted(() => ({
  feeds: new Map<string, { description: string; decimals: number; answer: bigint; updatedAt: number }>(),
  pool: { token0: '', token1: '', cumulatives: null as [bigint, bigint] | null, slot0Tick: 0n },
}));

const word = (v: bigint | number): string => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const addrWord = (a: string): string => a.slice(2).padStart(64, '0');
function str(s: string): string {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return word(32) + word(s.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
}

function answer(to: string, data: string): { result?: string; error?: { code: number; message: string } } {
  const feed = node.feeds.get(to);
  const sel = data.slice(0, 10);
  if (feed) {
    if (sel === '0x7284e416') return { result: `0x${str(feed.description)}` };
    if (sel === '0x313ce567') return { result: `0x${word(feed.decimals)}` };
    if (sel === '0xfeaf968c') {
      return { result: `0x${word(1)}${word(feed.answer)}${word(feed.updatedAt)}${word(feed.updatedAt)}${word(1)}` };
    }
  }
  if (to === POOL) {
    if (sel === '0x0dfe1681') return { result: `0x${addrWord(node.pool.token0)}` };
    if (sel === '0xd21220a7') return { result: `0x${addrWord(node.pool.token1)}` };
    if (sel === '0x883bdbfd') {
      if (!node.pool.cumulatives) return { error: { code: 3, message: 'execution reverted: OLD' } };
      const [c0, c1] = node.pool.cumulatives;
      return { result: `0x${word(64)}${word(160)}${word(2)}${word(c0)}${word(c1)}${word(2)}${word(0)}${word(0)}` };
    }
    if (sel === '0x3850c7bd') return { result: `0x${word(1n << 96n)}${word(node.pool.slot0Tick)}${word(0).repeat(5)}` };
  }
  return { error: { code: 3, message: 'execution reverted' } };
}

vi.mock('axios', () => ({
  default: {
    post: (_url: string, body: { params: [{ to: string; data: string }, string] }) => {
      const [{ to, data }, block] = body.params;
      calls.push({ to, data, block });
      return Promise.resolve({ data: { jsonrpc: '2.0', id: 1, ...answer(to, data) } });
    },
  },
}));
const recorded = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../src/db.js', () => ({
  query: (_sql: string, params: unknown[]) => { recorded.push(params); return Promise.resolve({ rows: [] }); },
}));

const { ethUsdAt, bnkrUsdAt, bnkrInWethAt, resetPriceSourceChecks, PRICE_SOURCES, TWAP_SECONDS } =
  await import('../../src/pricing/onchain.js');
const { BASE_BNKR } = await import('../../src/ingestion/assets.js');
const { BASE_WETH } = await import('../../src/classification/shape.js');

const ETH_FEED = PRICE_SOURCES.eth_usd_feed.address;
const POOL = PRICE_SOURCES.bnkr_weth_pool.address;
const AT = new Date('2026-09-24T12:00:00Z');
const T = Math.floor(AT.getTime() / 1000);

describe('on-chain prices', () => {
  beforeEach(() => {
    calls.length = 0;
    recorded.length = 0;
    resetPriceSourceChecks();
    node.feeds.clear();
    node.feeds.set(ETH_FEED, { description: 'ETH / USD', decimals: 8, answer: 251_234_000_000n, updatedAt: T - 300 });
    node.pool.token0 = BASE_BNKR;
    node.pool.token1 = BASE_WETH;
    node.pool.cumulatives = [0n, -69_082n * BigInt(TWAP_SECONDS)];
    node.pool.slot0Tick = -69_000n;
  });

  it('reads Chainlink ETH/USD at the transfer block, after checking the feed', async () => {
    expect(await ethUsdAt('k', 51_733_472, AT)).toBe(2512.34);
    const read = calls.find((c) => c.data === '0xfeaf968c');
    expect(read).toEqual({ to: ETH_FEED, data: '0xfeaf968c', block: `0x${(51_733_472).toString(16)}` });
    expect(recorded.some((p) => p.includes('eth_usd_feed') && p.includes('ok'))).toBe(true);
  });

  it('never uses a feed whose on-chain description does not match', async () => {
    node.feeds.set(ETH_FEED, { description: 'BTC / USD', decimals: 8, answer: 6_000_000_000_000n, updatedAt: T });
    expect(await ethUsdAt('k', 100, AT)).toBeNull();
    expect(calls.some((c) => c.data === '0xfeaf968c')).toBe(false);
    expect(recorded.some((p) => p.includes('mismatch'))).toBe(true);
  });

  it('ignores a stale Chainlink answer', async () => {
    node.feeds.set(ETH_FEED, { description: 'ETH / USD', decimals: 8, answer: 250_000_000_000n, updatedAt: T - 3 * 3600 });
    expect(await ethUsdAt('k', 100, AT)).toBeNull();
  });

  it('prices BNKR from the pool 30-minute average times ETH/USD', async () => {
    const r = await bnkrUsdAt('k', 200, AT);
    expect(r?.kind).toBe('twap');
    // 1.0001^-69082 WETH per BNKR ≈ 0.001, times $2,512.34
    expect(r?.usd).toBeCloseTo(1.0001 ** -69_082 * 2512.34, 10);
  });

  it('rounds the average tick toward negative infinity, like Uniswap', async () => {
    node.pool.cumulatives = [0n, -69_082n * BigInt(TWAP_SECONDS) - 1n];
    expect((await bnkrInWethAt('k', 201))?.wethPerBnkr).toBeCloseTo(1.0001 ** -69_083, 12);
  });

  it('uses the pool price at the block when its history is shorter than 30 minutes', async () => {
    node.pool.cumulatives = null;
    const r = await bnkrInWethAt('k', 202);
    expect(r).toEqual({ wethPerBnkr: 1.0001 ** -69_000, kind: 'spot' });
  });

  it('never uses a pool that is not BNKR/WETH', async () => {
    node.pool.token1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    expect(await bnkrInWethAt('k', 203)).toBeNull();
    expect(calls.some((c) => c.data.startsWith('0x883bdbfd'))).toBe(false);
  });
});
