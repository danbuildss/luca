import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { BASE_USDC, BASE_BNKR } from './assets.js';
import type { AssetIdentity } from './assets.js';

export type PriceResult = {
  usd_value: number | null;
  price_source: string | null;
  price_at: Date | null;
};

// price_source values:
//   'stable'           USDC at $1
//   'coingecko_spot'   live price, used for transfers under an hour old
//   'coingecko_daily'  CoinGecko's daily price for the transfer's UTC date (ETH only)
//   'unavailable'      no trustworthy price exists (BNKR older than an hour)
//   null               lookup failed; the worker retries (see repriceMissing)
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

// Live prices for valuing balances. Null when CoinGecko is unavailable.
export async function getSpotPrices(): Promise<{ ETH: number | null; BNKR: number | null }> {
  const [eth, bnkr] = await Promise.all([
    cached(spotCache, 'eth', SPOT_TTL_MS, fetchEthSpot),
    cached(spotCache, 'bnkr', SPOT_TTL_MS, fetchBnkrSpot),
  ]);
  return { ETH: eth, BNKR: bnkr };
}

export async function enrichUsdValue(
  identity: AssetIdentity,
  amount: number | null,
  blockTime: Date,
  now: Date = new Date(),
): Promise<PriceResult> {
  if (!identity.supported || amount === null || amount === 0) return NO_PRICE;

  if (identity.tokenAddress === BASE_USDC) {
    return { usd_value: amount, price_source: 'stable', price_at: blockTime };
  }

  const recent = now.getTime() - blockTime.getTime() < SPOT_WINDOW_MS;

  if (identity.tokenAddress === null && identity.symbol === 'ETH') {
    if (recent) {
      const spot = await cached(spotCache, 'eth', SPOT_TTL_MS, fetchEthSpot);
      if (spot !== null) return { usd_value: amount * spot, price_source: 'coingecko_spot', price_at: now };
    }
    const date = toCoingeckoDate(blockTime);
    const daily = await cached(dailyCache, `eth:${date}`, Number.POSITIVE_INFINITY, () => fetchEthDaily(date));
    if (daily === null) return NO_PRICE;
    return { usd_value: amount * daily, price_source: 'coingecko_daily', price_at: blockTime };
  }

  if (identity.tokenAddress === BASE_BNKR) {
    if (!recent) return { usd_value: null, price_source: 'unavailable', price_at: null };
    const spot = await cached(spotCache, 'bnkr', SPOT_TTL_MS, fetchBnkrSpot);
    if (spot === null) return NO_PRICE;
    return { usd_value: amount * spot, price_source: 'coingecko_spot', price_at: now };
  }

  return NO_PRICE;
}
