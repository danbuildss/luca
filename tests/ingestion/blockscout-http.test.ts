import { describe, it, expect, vi, beforeEach } from 'vitest';

// The exact requests made to Blockscout's API
const get = vi.fn<(url: string) => Promise<unknown>>();
vi.mock('axios', () => ({ default: { get: (url: string) => get(url) } }));

const { fetchNativeTransactions } = await import('../../src/ingestion/blockscout.js');

const W = '0xabc0000000000000000000000000000000000001';
const tx = (hash: string, block: number, from: string, to: string, value = '1000') => ({
  hash, block_number: block, timestamp: '2026-09-26T10:00:00Z', from: { hash: from }, to: { hash: to },
  value, gas_used: '21000', gas_price: '1', status: 'ok',
});

describe('fetchNativeTransactions', () => {
  beforeEach(() => get.mockReset());

  it('asks for both directions without a filter (Blockscout rejects "to | from" with 422)', async () => {
    get.mockResolvedValue({ data: { items: [
      tx('0x2', 120, '0xother', W),
      tx('0x1', 110, W, '0xother'),
    ], next_page_params: null } });
    const txs = await fetchNativeTransactions(W, 100);
    const url = new URL(get.mock.calls[0][0]);
    expect(url.pathname).toBe(`/api/v2/addresses/${W}/transactions`);
    expect(url.searchParams.has('filter')).toBe(false);
    expect(txs.map((t) => t.hash)).toEqual(['0x2', '0x1']);
  });

  it('follows next_page_params and keeps only successful, value-bearing transactions', async () => {
    get
      .mockResolvedValueOnce({ data: { items: [tx('0x3', 130, '0xo', W), tx('0xz', 125, W, '0xo', '0')], next_page_params: { block_number: 125, index: 3 } } })
      .mockResolvedValueOnce({ data: { items: [tx('0x4', 105, '0xo', W), tx('0x5', 90, '0xo', W)], next_page_params: null } });
    const txs = await fetchNativeTransactions(W, 100);
    expect(txs.map((t) => t.hash)).toEqual(['0x3', '0x4']);
    const second = new URL(get.mock.calls[1][0]);
    expect(second.searchParams.get('block_number')).toBe('125');
    expect(second.searchParams.has('filter')).toBe(false);
  });
});
