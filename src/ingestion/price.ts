import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { BASE_USDC, BASE_BNKR } from './assets.js';
import type { AssetIdentity } from './assets.js';
import { ethUsdAt, bnkrUsdAt } from '../pricing/onchain.js';

export type PriceResult = {
  usd_value: number | null;
  price_source: string | null;
  price_at: Date | null;
  // Where the value came from, in words (normalized_events.price_ref)
  price_ref?: string | null;
};

// Read prices from Base at this block (src/pricing/onchain.ts)
export type ChainContext = { apiKey: string; blockNumber: number };

// price_source values, best first:
//   'stable'           USDC at $1
//   'swap'             BNKR in one of the operator's swaps: the price they actually got
//   'chainlink'        ETH: Chainlink ETH/USD at the transfer's block
//   'pool_twap'        BNKR: Uniswap BNKR/WETH 30-minute average at the block, times ETH/USD
//   'pool_spot'        BNKR: the pool's price at the block (its history was too short)
//   'coingecko_spot'   live price, for transfers under an hour old when the chain read failed
//   'coingecko_daily'  CoinGecko's daily price for the transfer's UTC date (ETH only)
//   'unavailable'      no trustworthy price exists
//   null               lookup failed; the worker retries (see repriceMissing)
export const ONCHAIN_PRICE_SOURCES = ['stable', 'swap', 'chainlink', 'pool_twap', 'pool_spot'];
const SPOT_WINDOW_MS = 60 * 60 * 1000;
const SPOT_TTL_MS = 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;

const NO_PRICE: PriceResult = { usd_value: null, price_source: null, price_at: null };

type CachedPrice = { price: number | null; at: number };
const spotCache = new Map<string, CachedPrice>();
const dailyCache = new Map<string, CachedPrice>();

function baseUrl(): string {
  return config.COINGECKO_API_TIER === 'pro'
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
}

function headers(): Record<string, string> {
  if (!config.COINGECKO_API_KEY) return {};
  const name = config.COINGECKO_API_TIER === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
  return { [name]: config.COINGECKO_API_KEY };
}

async function cached(
  cache: Map<string, CachedPrice>,
  key: string,
  ttlMs: number,
  fetchPrice: () => Promise<number | null>,
): Promise<number | null> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < (hit.price === null ? FAILURE_TTL_MS : ttlMs)) return hit.price;
  const price = await fetchPrice();
  cache.set(key, { price, at: now });
  return price;
}

type SimplePriceResponse = Record<string, { usd?: number } | undefined>;
type HistoryResponse = { market_data?: { current_price?: { usd?: number } } };

async function fetchEthSpot(): Promise<number | null> {
  try {
    const res = await axios.get<SimplePriceResponse>(`${baseUrl()}/simple/price`, {
      params: { ids: 'ethereum', vs_currencies: 'usd' },
      headers: headers(),
      timeout: 8000,
    });
    const price = res.data.ethereum?.usd;
    return typeof price === 'number' ? price : null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'CoinGecko ETH spot price fetch failed');
    return null;
  }
}

async function fetchBnkrSpot(): Promise<number | null> {
  try {
    const res = await axios.get<SimplePriceResponse>(`${baseUrl()}/simple/token_price/base`, {
      params: { contract_addresses: BASE_BNKR, vs_currencies: 'usd' },
      headers: headers(),
      timeout: 8000,
    });
    const price = res.data[BASE_BNKR]?.usd;
    return typeof price === 'number' ? price : null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'CoinGecko BNKR spot price fetch failed');
    return null;
  }
}

function toCoingeckoDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

async function fetchEthDaily(date: string): Promise<number | null> {
  try {
    const res = await axios.get<HistoryResponse>(`${baseUrl()}/coins/ethereum/history`, {
      params: { date, localization: false },
      headers: headers(),
      timeout: 8000,
    });
    const price = res.data.market_data?.current_price?.usd;
    return typeof price === 'number' ? price : null;
  } catch (err) {
    logger.warn({ date, err: (err as Error).message }, 'CoinGecko ETH daily price fetch failed');
    return null;
  }
}

// Live prices for valuing balances: read on chain when possible, CoinGecko otherwise.
// Null when neither is available.
export async function getSpotPrices(apiKey: string | undefined = config.ALCHEMY_API_KEY): Promise<{ ETH: number | null; BNKR: number | null }> {
  const [ethChain, bnkrChain] = apiKey
    ? await Promise.all([
        ethUsdAt(apiKey, 'latest').catch(() => null),
        bnkrUsdAt(apiKey, 'latest').catch(() => null),
      ])
    : [null, null];
  const [eth, bnkr] = await Promise.all([
    ethChain ?? cached(spotCache, 'eth', SPOT_TTL_MS, fetchEthSpot),
    bnkrChain?.usd ?? cached(spotCache, 'bnkr', SPOT_TTL_MS, fetchBnkrSpot),
  ]);
  return { ETH: eth, BNKR: bnkr };
}

function fmtBlock(n: number): string {
  return n.toLocaleString('en-US');
}

export async function enrichUsdValue(
  identity: AssetIdentity,
  amount: number | null,
  blockTime: Date,
  now: Date = new Date(),
  chain?: ChainContext,
): Promise<PriceResult> {
  if (!identity.supported || amount === null || amount === 0) return NO_PRICE;

  if (identity.tokenAddress === BASE_USDC) {
    return { usd_value: amount, price_source: 'stable', price_at: blockTime, price_ref: 'USDC counted at $1' };
  }

  const recent = now.getTime() - blockTime.getTime() < SPOT_WINDOW_MS;

  if (identity.tokenAddress === null && identity.symbol === 'ETH') {
    if (chain) {
      const eth = await ethUsdAt(chain.apiKey, chain.blockNumber, blockTime);
      if (eth !== null) {
        return {
          usd_value: amount * eth,
          price_source: 'chainlink',
          price_at: blockTime,
          price_ref: `Chainlink ETH/USD $${eth.toFixed(2)} at block ${fmtBlock(chain.blockNumber)}`,
        };
      }
    }
    if (recent) {
      const spot = await cached(spotCache, 'eth', SPOT_TTL_MS, fetchEthSpot);
      if (spot !== null) {
        return { usd_value: amount * spot, price_source: 'coingecko_spot', price_at: now, price_ref: 'CoinGecko live price' };
      }
    }
    const date = toCoingeckoDate(blockTime);
    const daily = await cached(dailyCache, `eth:${date}`, Number.POSITIVE_INFINITY, () => fetchEthDaily(date));
    if (daily === null) return NO_PRICE;
    return {
      usd_value: amount * daily,
      price_source: 'coingecko_daily',
      price_at: blockTime,
      price_ref: `CoinGecko daily ETH price for ${blockTime.toISOString().slice(0, 10)}`,
    };
  }

  if (identity.tokenAddress === BASE_BNKR) {
    if (chain) {
      const bnkr = await bnkrUsdAt(chain.apiKey, chain.blockNumber, blockTime);
      if (bnkr !== null) {
        return {
          usd_value: amount * bnkr.usd,
          price_source: bnkr.kind === 'twap' ? 'pool_twap' : 'pool_spot',
          price_at: blockTime,
          price_ref: `Uniswap BNKR/WETH ${bnkr.kind === 'twap' ? '30-minute average' : 'price'} at block ${fmtBlock(chain.blockNumber)}, with Chainlink ETH/USD`,
        };
      }
    }
    if (!recent) return { usd_value: null, price_source: 'unavailable', price_at: null, price_ref: null };
    const spot = await cached(spotCache, 'bnkr', SPOT_TTL_MS, fetchBnkrSpot);
    if (spot === null) return NO_PRICE;
    return { usd_value: amount * spot, price_source: 'coingecko_spot', price_at: now, price_ref: 'CoinGecko live price' };
  }

  return NO_PRICE;
}
