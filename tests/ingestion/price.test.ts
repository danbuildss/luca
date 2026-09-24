import { describe, it, expect, vi, beforeEach } from 'vitest';

type GetConfig = { params?: Record<string, string | boolean> };
const get = vi.fn<[string, GetConfig?], Promise<unknown>>();
vi.mock('axios', () => ({ default: { get: (url: string, cfg?: GetConfig) => get(url, cfg) } }));

const { enrichUsdValue } = await import('../../src/ingestion/price.js');
const { BASE_USDC, BASE_BNKR } = await import('../../src/ingestion/assets.js');

const NOW = new Date('2026-09-24T12:00:00Z');
const RECENT = new Date('2026-09-24T11:50:00Z');
const OLD = new Date('2026-09-20T09:00:00Z');

const ETH = { supported: true, symbol: 'ETH', tokenAddress: null };
const USDC = { supported: true, symbol: 'USDC', tokenAddress: BASE_USDC };
const BNKR = { supported: true, symbol: 'BNKR', tokenAddress: BASE_BNKR };

describe('enrichUsdValue', () => {
  beforeEach(() => get.mockReset());

  it('values USDC at $1 without calling CoinGecko', async () => {
    expect(await enrichUsdValue(USDC, 250, OLD, NOW)).toEqual({ usd_value: 250, price_source: 'stable', price_at: OLD });
    expect(get).not.toHaveBeenCalled();
  });

  it('never prices an unsupported token, even one named USDC', async () => {
    const fake = { supported: false, symbol: 'USDC', tokenAddress: '0x1111111111111111111111111111111111111111' };
    expect((await enrichUsdValue(fake, 1_000_000, RECENT, NOW)).usd_value).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('prices a recent ETH transfer at the live spot price', async () => {
    get.mockResolvedValueOnce({ data: { ethereum: { usd: 4000 } } });
    const r = await enrichUsdValue(ETH, 0.5, RECENT, NOW);
    expect(r).toEqual({ usd_value: 2000, price_source: 'coingecko_spot', price_at: NOW });
    expect(get.mock.calls[0][0]).toContain('/simple/price');
  });

  it('prices an older ETH transfer at that day\'s price', async () => {
    get.mockResolvedValueOnce({ data: { market_data: { current_price: { usd: 3500 } } } });
    const r = await enrichUsdValue(ETH, 2, OLD, NOW);
    expect(r).toEqual({ usd_value: 7000, price_source: 'coingecko_daily', price_at: OLD });
    expect(get.mock.calls[0][1]?.params?.date).toBe('20-09-2026');
  });

  it('never gives an old BNKR transfer today\'s price', async () => {
    const r = await enrichUsdValue(BNKR, 1000, OLD, NOW);
    expect(r).toEqual({ usd_value: null, price_source: 'unavailable', price_at: null });
    expect(get).not.toHaveBeenCalled();
  });

  it('prices a recent BNKR transfer at the live contract price', async () => {
    get.mockResolvedValueOnce({ data: { [BASE_BNKR]: { usd: 0.0005 } } });
    const r = await enrichUsdValue(BNKR, 1000, RECENT, new Date(NOW.getTime() + 120_000));
    expect(r.usd_value).toBeCloseTo(0.5);
    expect(r.price_source).toBe('coingecko_spot');
  });

  it('leaves a failed lookup retryable (price_source null)', async () => {
    get.mockImplementationOnce(() => Promise.reject(new Error('429')));
    const r = await enrichUsdValue(ETH, 1, new Date('2026-09-10T09:00:00Z'), NOW);
    expect(r).toEqual({ usd_value: null, price_source: null, price_at: null });
  });
});
