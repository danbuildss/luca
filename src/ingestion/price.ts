import axios from 'axios';
import { logger } from '../logger.js';

// Recognized token contracts on Base mainnet
export const USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BNKR_CONTRACT = '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b';

export type PriceResult = {
  usd_value: number | null;
  price_source: string | null;
  price_at: Date | null;
};

// Cache ETH and BNKR prices by UTC date string (dd-mm-yyyy) to reduce CoinGecko calls
// during 30-day backfill. Keys: "eth:dd-mm-yyyy", "bnkr:dd-mm-yyyy"
const priceCache = new Map<string, number>();

function toDateStr(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

async function fetchCoingeckoHistorical(coinId: string, dateStr: string): Promise<number | null> {
  try {
    const res = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/history`, {
      params: { date: dateStr, localization: false },
      timeout: 8000,
    });
    const price = res.data?.market_data?.current_price?.usd;
    return typeof price === 'number' ? price : null;
  } catch (err) {
    logger.warn({ coinId, dateStr, err }, 'CoinGecko historical price fetch failed');
    return null;
  }
}

async function fetchCoingeckoContractPrice(
  chainId: string,
  contractAddress: string,
): Promise<number | null> {
  try {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/token_price/${chainId}`,
      {
        params: { contract_addresses: contractAddress, vs_currencies: 'usd' },
        timeout: 8000,
      },
    );
    const price = res.data?.[contractAddress.toLowerCase()]?.usd;
    return typeof price === 'number' ? price : null;
  } catch (err) {
    logger.warn({ chainId, contractAddress, err }, 'CoinGecko contract price fetch failed');
    return null;
  }
}

async function getCachedPrice(
  coinId: string,
  fallbackFn: () => Promise<number | null>,
  blockTime: Date,
): Promise<number | null> {
  const dateStr = toDateStr(blockTime);
  const key = `${coinId}:${dateStr}`;

  if (priceCache.has(key)) return priceCache.get(key)!;

  const price = await fallbackFn();
  if (price !== null) priceCache.set(key, price);
  return price;
}

export async function enrichUsdValue(
  asset: string | null,
  contractAddress: string | null,
  amount: number | null,
  blockTime: Date,
): Promise<PriceResult> {
  if (amount === null || amount === 0) {
    return { usd_value: null, price_source: null, price_at: null };
  }

  const symbol = (asset ?? '').toUpperCase();
  const contract = (contractAddress ?? '').toLowerCase();

  // USDC — stable 1:1
  if (symbol === 'USDC' || contract === USDC_CONTRACT) {
    return { usd_value: amount, price_source: 'stable', price_at: blockTime };
  }

  // ETH (native transfers)
  if (symbol === 'ETH') {
    const dateStr = toDateStr(blockTime);
    const price = await getCachedPrice(
      'eth',
      () => fetchCoingeckoHistorical('ethereum', dateStr),
      blockTime,
    );
    if (price === null) return { usd_value: null, price_source: null, price_at: null };
    return { usd_value: amount * price, price_source: 'coingecko', price_at: blockTime };
  }

  // BNKR — use contract address lookup (current spot; historical not available on free tier)
  if (symbol === 'BNKR' || contract === BNKR_CONTRACT) {
    const price = await getCachedPrice(
      'bnkr',
      () => fetchCoingeckoContractPrice('base', BNKR_CONTRACT),
      blockTime,
    );
    if (price === null) return { usd_value: null, price_source: null, price_at: null };
    return { usd_value: amount * price, price_source: 'coingecko', price_at: blockTime };
  }

  // All other tokens — no USD value
  return { usd_value: null, price_source: null, price_at: null };
}
