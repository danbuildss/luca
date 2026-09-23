import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB — all detector SQL goes through query()
vi.mock('../../src/db.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn() },
}));

// Mock format helpers (tested separately in telegram/format.test.ts)
vi.mock('../../src/telegram/format.js', () => ({
  formatAddress: (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`,
}));

import * as db from '../../src/db.js';
import { detectSpendSpike, detectTreasuryFloor, detectUnusualGas } from '../../src/alerts/detectors.js';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

// Helper: make query return rows in sequence across multiple calls
function queueQueryResults(...results: Array<{ rows: unknown[] }>) {
  let idx = 0;
  mockQuery.mockImplementation(() => Promise.resolve(results[idx++ % results.length]));
}

describe('detectSpendSpike', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts alert when 24h spend is 2x+ daily average', async () => {
    // First call: spend stats. Second call: INSERT ... RETURNING
    queueQueryResults(
      { rows: [{ spend_24h: '200', spend_7d: '700', materiality_usd: '50' }] },
      { rows: [{ id: 'alert-1' }] }, // INSERT returned — new alert
    );

    const count = await detectSpendSpike('user-1');
    expect(count).toBe(1);

    // Verify INSERT was called with correct dedup key prefix
    const insertCall = mockQuery.mock.calls[1] as unknown[];
    expect(insertCall[0]).toContain('ON CONFLICT (dedup_key) DO NOTHING');
    const dedupKey = (insertCall[1] as unknown[])[4] as string;
    expect(dedupKey).toMatch(/^spend_spike:user-1:/);
  });

  it('does not fire when ratio < 2', async () => {
    queueQueryResults(
      { rows: [{ spend_24h: '60', spend_7d: '700', materiality_usd: '50' }] },
    );
    const count = await detectSpendSpike('user-1');
    expect(count).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(1); // no INSERT
  });

  it('does not fire when 24h spend is below materiality threshold', async () => {
    // Ratio is infinite (avg=0) but spend is $5 — below $50 threshold
    queueQueryResults(
      { rows: [{ spend_24h: '5', spend_7d: '5', materiality_usd: '50' }] },
    );
    const count = await detectSpendSpike('user-1');
    expect(count).toBe(0);
  });

  it('returns 0 on dedup hit (INSERT returns no rows)', async () => {
    queueQueryResults(
      { rows: [{ spend_24h: '300', spend_7d: '700', materiality_usd: '50' }] },
      { rows: [] }, // ON CONFLICT DO NOTHING — already exists
    );
    const count = await detectSpendSpike('user-1');
    expect(count).toBe(0);
  });
});

describe('detectTreasuryFloor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts alert when treasury USDC balance is below threshold', async () => {
    queueQueryResults(
      {
        rows: [{
          wallet_id: 'w-1',
          wallet_address: '0xTREASURY1234567890abcdef',
          wallet_label: 'treasury',
          balance: '30',
          materiality_usd: '50',
        }],
      },
      { rows: [{ id: 'alert-2' }] },
    );

    const count = await detectTreasuryFloor('user-1');
    expect(count).toBe(1);

    const dedupKey = ((mockQuery.mock.calls[1] as unknown[])[1] as unknown[])[4] as string;
    expect(dedupKey).toMatch(/^treasury_floor:w-1:/);
  });

  it('does not fire when balance is above threshold', async () => {
    queueQueryResults({
      rows: [{
        wallet_id: 'w-1',
        wallet_address: '0xTREASURY1234567890abcdef',
        wallet_label: null,
        balance: '500',
        materiality_usd: '50',
      }],
    });
    const count = await detectTreasuryFloor('user-1');
    expect(count).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when no treasury wallets exist', async () => {
    queueQueryResults({ rows: [] });
    const count = await detectTreasuryFloor('user-1');
    expect(count).toBe(0);
  });
});

describe('detectUnusualGas', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts alert when 24h gas is 5x+ daily average', async () => {
    queueQueryResults(
      { rows: [{ gas_24h: '15', gas_7d: '14' }] }, // avg = 2/day, today = 15
      { rows: [{ id: 'alert-3' }] },
    );

    const count = await detectUnusualGas('user-1');
    expect(count).toBe(1);
  });

  it('does not fire when sub-$1 gas (noise guard)', async () => {
    queueQueryResults(
      { rows: [{ gas_24h: '0.50', gas_7d: '0.01' }] },
    );
    const count = await detectUnusualGas('user-1');
    expect(count).toBe(0);
  });

  it('does not fire when ratio < 5', async () => {
    queueQueryResults(
      { rows: [{ gas_24h: '5', gas_7d: '35' }] }, // avg = 5, ratio = 1
    );
    const count = await detectUnusualGas('user-1');
    expect(count).toBe(0);
  });
});
