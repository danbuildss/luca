import { query } from '../db.js';
import { logger } from '../logger.js';
import { ethCall } from '../ingestion/alchemy.js';
import { BASE_BNKR } from '../ingestion/assets.js';
import { BASE_WETH } from '../classification/shape.js';

// Prices read from Base itself, at the block a transfer happened:
//   ETH/USD  - Chainlink's aggregator (latestRoundData at that block)
//   USDC/USD - Chainlink's aggregator, to watch the $1 peg
//   BNKR     - the Uniswap V3 BNKR/WETH pool's 30-minute average (observe), times ETH/USD
// No address is trusted because it is written here: each source is checked on chain
// (feed description and decimals, pool tokens) before its first use and hourly after.

export const PRICE_SOURCES = {
  eth_usd_feed: { address: '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70', expect: 'ETH / USD' },
  usdc_usd_feed: { address: '0x7e860098f58bbfc8648a4311b374b1d669a2bc6b', expect: 'USDC / USD' },
  bnkr_weth_pool: { address: '0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703', expect: 'BNKR/WETH' },
} as const;
export type PriceSourceName = keyof typeof PRICE_SOURCES;

export const TWAP_SECONDS = 1800;
// A Chainlink answer older than this at the block is not used (Base ETH/USD updates at
// least every 20 minutes)
const STALE_AFTER_S = 2 * 60 * 60;
const VERIFY_TTL_MS = 60 * 60 * 1000;
// A check that failed to read (network, node) is retried sooner than a real mismatch
const VERIFY_ERROR_TTL_MS = 5 * 60 * 1000;
const FEED_DECIMALS = 8;

const SEL = {
  latestRoundData: '0xfeaf968c',
  description: '0x7284e416',
  decimals: '0x313ce567',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  observe: '0x883bdbfd',
  slot0: '0x3850c7bd',
};

// ---- ABI decoding (only what these calls return) ----

function words(hex: string): string[] {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: string[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}
const uint = (w: string): bigint => BigInt(`0x${w}`);
const int = (w: string): bigint => BigInt.asIntN(256, uint(w));
const address = (w: string): string => `0x${w.slice(24)}`.toLowerCase();
const pad = (n: number | bigint): string => BigInt(n).toString(16).padStart(64, '0');

function decodeString(hex: string): string {
  const w = words(hex);
  if (w.length < 2) return '';
  const len = Number(uint(w[1]));
  const bytes = hex.slice(2).slice(128, 128 + len * 2);
  return Buffer.from(bytes, 'hex').toString('utf8');
}

// ---- Source verification ----

export type SourceCheck = {
  name: PriceSourceName;
  address: string;
  status: 'ok' | 'mismatch' | 'error';
  detail: string;
};

const verified = new Map<PriceSourceName, { check: SourceCheck; at: number }>();

async function inspect(apiKey: string, name: PriceSourceName): Promise<SourceCheck> {
  const { address: addr, expect } = PRICE_SOURCES[name];
  try {
    if (name === 'bnkr_weth_pool') {
      const [t0, t1] = await Promise.all([
        ethCall(apiKey, addr, SEL.token0, 'latest'),
        ethCall(apiKey, addr, SEL.token1, 'latest'),
      ]);
      const tokens = [address(words(t0)[0] ?? ''), address(words(t1)[0] ?? '')].sort();
      const ok = tokens[0] === [BASE_BNKR, BASE_WETH].sort()[0] && tokens[1] === [BASE_BNKR, BASE_WETH].sort()[1];
      return { name, address: addr, status: ok ? 'ok' : 'mismatch', detail: `tokens ${tokens.join(', ')}` };
    }
    const [desc, dec] = await Promise.all([
      ethCall(apiKey, addr, SEL.description, 'latest'),
      ethCall(apiKey, addr, SEL.decimals, 'latest'),
    ]);
    const description = decodeString(desc);
    const decimals = Number(uint(words(dec)[0] ?? '0'));
    const ok = description === expect && decimals === FEED_DECIMALS;
    return { name, address: addr, status: ok ? 'ok' : 'mismatch', detail: `"${description}", ${decimals} decimals` };
  } catch (err) {
    return { name, address: addr, status: 'error', detail: (err as Error).message.slice(0, 200) };
  }
}

// Checks a source on chain (cached for an hour, recorded for /ops). Only 'ok' is used.
export async function verifySource(apiKey: string, name: PriceSourceName): Promise<SourceCheck> {
  const hit = verified.get(name);
  if (hit && Date.now() - hit.at < (hit.check.status === 'error' ? VERIFY_ERROR_TTL_MS : VERIFY_TTL_MS)) return hit.check;
  const check = await inspect(apiKey, name);
  verified.set(name, { check, at: Date.now() });
  if (check.status !== 'ok') logger.warn({ check }, 'Price source failed its on-chain check; not used');
  await query(
    `INSERT INTO price_sources (name, address, status, detail, checked_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (name) DO UPDATE
       SET address = EXCLUDED.address, status = EXCLUDED.status, detail = EXCLUDED.detail, checked_at = NOW()`,
    [check.name, check.address, check.status, check.detail],
  ).catch((err: unknown) => logger.warn({ err }, 'Could not record price source check'));
  return check;
}

export function resetPriceSourceChecks(): void {
  verified.clear();
  cache.clear();
}

// ---- Reads at a block ----

const cache = new Map<string, number | null>();
async function memo(key: string, read: () => Promise<number | null>): Promise<number | null> {
  if (cache.has(key)) return cache.get(key) ?? null;
  const value = await read();
  if (cache.size > 20_000) cache.clear();
  // 'latest' reads are not memoized: they change every block
  if (!key.endsWith(':latest')) cache.set(key, value);
  return value;
}

type Block = number | 'latest';

// Chainlink answer in USD at the block; null when stale, unreadable or unverified.
async function feedUsd(apiKey: string, name: 'eth_usd_feed' | 'usdc_usd_feed', block: Block, atSeconds: number): Promise<number | null> {
  if ((await verifySource(apiKey, name)).status !== 'ok') return null;
  return memo(`${name}:${block}`, async () => {
    try {
      const w = words(await ethCall(apiKey, PRICE_SOURCES[name].address, SEL.latestRoundData, block));
      if (w.length < 5) return null;
      const answer = int(w[1]);
      const updatedAt = Number(uint(w[3]));
      if (answer <= 0n || atSeconds - updatedAt > STALE_AFTER_S) return null;
      return Number(answer) / 10 ** FEED_DECIMALS;
    } catch (err) {
      logger.warn({ err: (err as Error).message, name, block }, 'Chainlink read failed');
      return null;
    }
  });
}

export function ethUsdAt(apiKey: string, block: Block, at: Date = new Date()): Promise<number | null> {
  return feedUsd(apiKey, 'eth_usd_feed', block, Math.floor(at.getTime() / 1000));
}

export function usdcUsdAt(apiKey: string, block: Block, at: Date = new Date()): Promise<number | null> {
  return feedUsd(apiKey, 'usdc_usd_feed', block, Math.floor(at.getTime() / 1000));
}

// WETH per BNKR from the pool: the 30-minute average tick, or the spot tick at that block
// when the pool's history does not reach back 30 minutes.
export async function bnkrInWethAt(
  apiKey: string,
  block: Block,
): Promise<{ wethPerBnkr: number; kind: 'twap' | 'spot' } | null> {
  if ((await verifySource(apiKey, 'bnkr_weth_pool')).status !== 'ok') return null;
  const pool = PRICE_SOURCES.bnkr_weth_pool.address;
  // token0 is the lower address: BNKR (0x22af…) before WETH (0x4200…), so the pool's
  // price (token1 per token0) is WETH per BNKR
  const bnkrIsToken0 = BASE_BNKR < BASE_WETH;
  const fromTick = (tick: number): number => {
    const p = 1.0001 ** tick;
    return bnkrIsToken0 ? p : 1 / p;
  };

  let kind: 'twap' | 'spot' = 'twap';
  const tick = await memo(`pool:${block}`, async () => {
    try {
      const data = SEL.observe + pad(0x20) + pad(2) + pad(TWAP_SECONDS) + pad(0);
      const w = words(await ethCall(apiKey, pool, data, block));
      const off = Number(uint(w[0])) / 32;
      const n = Number(uint(w[off]));
      if (n !== 2) return null;
      const delta = int(w[off + 2]) - int(w[off + 1]);
      // Round toward negative infinity, as Uniswap's OracleLibrary does
      let avg = delta / BigInt(TWAP_SECONDS);
      if (delta < 0n && delta % BigInt(TWAP_SECONDS) !== 0n) avg -= 1n;
      return Number(avg);
    } catch {
      return null;
    }
  });
  if (tick !== null) return { wethPerBnkr: fromTick(tick), kind };

  kind = 'spot';
  const spotTick = await memo(`slot0:${block}`, async () => {
    try {
      const w = words(await ethCall(apiKey, pool, SEL.slot0, block));
      return w.length >= 2 ? Number(int(w[1])) : null;
    } catch (err) {
      logger.warn({ err: (err as Error).message, block }, 'BNKR pool read failed');
      return null;
    }
  });
  return spotTick === null ? null : { wethPerBnkr: fromTick(spotTick), kind };
}

export async function bnkrUsdAt(
  apiKey: string,
  block: Block,
  at: Date = new Date(),
): Promise<{ usd: number; kind: 'twap' | 'spot' } | null> {
  const [inWeth, eth] = await Promise.all([bnkrInWethAt(apiKey, block), ethUsdAt(apiKey, block, at)]);
  if (!inWeth || eth === null) return null;
  return { usd: inWeth.wethPerBnkr * eth, kind: inWeth.kind };
}

export type PriceSourceRow = SourceCheck & { checked_at: Date };

export async function getPriceSourceChecks(): Promise<PriceSourceRow[]> {
  const res = await query<PriceSourceRow>(
    `SELECT name, address, status, detail, checked_at FROM price_sources ORDER BY name`,
  );
  return res.rows;
}
