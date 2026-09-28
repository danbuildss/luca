// Every provider call the worker makes has a time limit, so a slow provider fails and is
// retried instead of holding up the whole cycle (Sep 28: Blockscout slowed cycles to 9.6 min).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => ({ get: [] as Array<{ url: string; config: unknown }>, post: [] as Array<{ url: string; config: unknown }> }));
vi.mock('axios', () => ({
  default: {
    get: (url: string, config: unknown) => { calls.get.push({ url, config }); return Promise.resolve({ data: { items: [], next_page_params: null } }); },
    post: (url: string, _body: unknown, config: unknown) => { calls.post.push({ url, config }); return Promise.resolve({ data: { jsonrpc: '2.0', id: 1, result: '0x10' } }); },
  },
}));

import { fetchTokenTransfers, BLOCKSCOUT_TIMEOUT_MS } from '../../src/ingestion/blockscout.js';
import { getCurrentBlock, RPC_TIMEOUT_MS } from '../../src/ingestion/alchemy.js';

describe('provider calls have a time limit', () => {
  beforeEach(() => { calls.get.length = 0; calls.post.length = 0; });

  it('Blockscout: 20 seconds per request', async () => {
    await fetchTokenTransfers('0x' + '11'.repeat(20), 0);
    expect(calls.get).toHaveLength(1);
    expect(calls.get[0].config).toEqual({ timeout: BLOCKSCOUT_TIMEOUT_MS });
    expect(BLOCKSCOUT_TIMEOUT_MS).toBe(20_000);
  });

  it('Alchemy: 30 seconds per request', async () => {
    expect(await getCurrentBlock('key')).toBe(16);
    expect(calls.post[0].config).toEqual({ timeout: RPC_TIMEOUT_MS });
    expect(RPC_TIMEOUT_MS).toBe(30_000);
  });
});
