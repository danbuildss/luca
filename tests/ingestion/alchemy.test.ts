import { describe, it, expect, vi, beforeEach } from 'vitest';

type RpcBody = { method: string; params: Array<{ fromBlock: string; toBlock: string; pageKey?: string; fromAddress?: string; toAddress?: string }> };
const post = vi.fn<(url: string, body: RpcBody) => Promise<unknown>>();
vi.mock('axios', () => ({ default: { post: (url: string, body: RpcBody) => post(url, body) } }));

const { parseReceipt, getLogsChunked, fetchAllTransfers, RpcError } = await import('../../src/ingestion/alchemy.js');

const receipt = {
  transactionHash: '0xabc', blockNumber: '0x64', blockHash: '0xb100', from: '0xw', to: '0xc',
  gasUsed: '0x5208', effectiveGasPrice: '0xf4240', // 21000 gas at 1,000,000 wei
};

describe('parseReceipt', () => {
  it('fee is execution gas plus the L1 data fee', () => {
    const r = parseReceipt({ ...receipt, status: '0x1', l1Fee: '0x3e8' });
    expect(r.fee).toBe(21_000n * 1_000_000n + 1_000n);
    expect(r.status).toBe('success');
    expect(r.blockNumber).toBe(100);
  });

  it('adds the operator fee when the receipt carries one', () => {
    const r = parseReceipt({ ...receipt, status: '0x1', operatorFeeScalar: '0xf4240', operatorFeeConstant: '0x5' });
    // gasUsed * 1_000_000 / 1e6 + 5
    expect(r.operatorFee).toBe(21_005n);
    expect(r.fee).toBe(21_000n * 1_000_000n + 21_005n);
  });

  it('a failed transaction still costs its fee', () => {
    const r = parseReceipt({ ...receipt, status: '0x0' });
    expect(r.status).toBe('failed');
    expect(r.fee).toBe(21_000_000_000n);
  });
});

describe('getLogsChunked', () => {
  beforeEach(() => post.mockReset());
  const filter = { address: ['0xusdc'], topics: [null] };
  const ranges = (): Array<[number, number]> => post.mock.calls.map(([, b]) =>
    [parseInt(b.params[0].fromBlock, 16), parseInt(b.params[0].toBlock, 16)]);

  it('reads the range in fixed chunks', async () => {
    post.mockResolvedValue({ data: { result: [] } });
    await getLogsChunked('k', filter, 1, 5000, 2000);
    expect(ranges()).toEqual([[1, 2000], [2001, 4000], [4001, 5000]]);
  });

  it('halves the chunk when the node refuses a range, then continues', async () => {
    post
      .mockResolvedValueOnce({ data: { error: { code: -32005, message: 'too many results' } } })
      .mockResolvedValue({ data: { result: [{ blockNumber: '0x1', removed: false }] } });
    const logs = await getLogsChunked('k', filter, 1, 2000, 2000);
    expect(ranges()).toEqual([[1, 2000], [1, 1000], [1001, 2000]]);
    expect(logs).toHaveLength(2);
  });

  it('drops logs from reorged blocks', async () => {
    post.mockResolvedValue({ data: { result: [{ removed: true }, { removed: false }] } });
    expect(await getLogsChunked('k', filter, 1, 10)).toHaveLength(1);
  });

  it('gives up when even a single block is refused', async () => {
    post.mockResolvedValue({ data: { error: { code: -32005, message: 'too many results' } } });
    await expect(getLogsChunked('k', filter, 1, 4, 4)).rejects.toBeInstanceOf(RpcError);
  });
});

describe('fetchAllTransfers', () => {
  beforeEach(() => post.mockReset());
  const t = (hash: string) => ({ hash, uniqueId: `${hash}:log:1`, category: 'erc20' });

  it('follows pageKey through every page, sent and received', async () => {
    // Sent: two pages. Received: one page.
    post.mockImplementation((_url, body) => {
      const p = body?.params[0] ?? {};
      if (p.fromAddress && !p.pageKey) return Promise.resolve({ data: { result: { transfers: [t('0x1'), t('0x2')], pageKey: 'next' } } });
      if (p.fromAddress && p.pageKey === 'next') return Promise.resolve({ data: { result: { transfers: [t('0x3')] } } });
      return Promise.resolve({ data: { result: { transfers: [t('0x4')] } } });
    });
    const all = await fetchAllTransfers('k', '0xwallet', '0x1', '0x2');
    expect(all.map((x) => x.hash)).toEqual(['0x1', '0x2', '0x3', '0x4']);
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[1][1].params[0].pageKey).toBe('next');
  });
});
