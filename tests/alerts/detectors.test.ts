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
import {
  detectLargeMovements,
  detectSpendSpike,
  detectTreasuryFloor,
  detectUnusualGas,
} from '../../src/alerts/detectors.js';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

// Helper: make query return rows in sequence across multiple calls
function queueQueryResults(...results: Array<{ rows: unknown[] }>) {
  let idx = 0;
  mockQuery.mockImplementation(() => Promise.resolve(results[idx++ % results.length]));
}

// Baseline semantics: *_baseline is the sum over the PRIOR 6 days (last 24h excluded),
// so the daily average is baseline / 6.

describe('detectLargeMovements', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only considers recent events and excludes gas/internal/x402 labels', async () => {
    queueQueryResults({ rows: [] });
    await detectLargeMovements('user-1');

    const sql = (mockQuery.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toContain("ne.block_time >= NOW() - INTERVAL '24 hours'");
    expect(sql).toContain("'gas', 'internal_transfer', 'x402_income', 'x402_spend'");
  });
});

describe('detectSpendSpike', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts alert when 24h spend is 2x+ the prior 6-day daily average', async () => {
    // First call: spend stats. Second call: INSERT ... RETURNING
    queueQueryResults(
      { rows: [{ spend_24h: '250', spend_baseline: '600', materiality_usd: '50', has_history: true }] }, // avg 100/day, 2.5×
      { rows: [{ id: 'alert-1' }] }, // INSERT returned — new alert
    );

    const count = await detectSpendSpike('user-1');
    expect(count).toBe(1);

    const insertCall = mockQuery.mock.calls[1] as unknown[];
    expect(insertCall[0]).toContain('ON CONFLICT (dedup_key) DO NOTHING');
    const params = insertCall[1] as unknown[];
    expect(params[4] as string).toMatch(/^spend_spike:user-1:/);
    // Rolling 24h cooldown instead of per-UTC-date dedup
    expect(insertCall[0]).toContain('NOT EXISTS');
    expect(params[5]).toBe(24);
    const evidence = JSON.parse(params[3] as string) as { daily_avg: number; spike_ratio: number };
    expect(evidence.daily_avg).toBe(100);
    expect(evidence.spike_ratio).toBe(2.5);
  });

  it('fires at exactly 2x of the prior-6-day average (not diluted by the last 24h)', async () => {
    // Old 7-day-inclusive math: (600 + 200) / 7 = 114 → 1.75×, would not fire.
    queueQueryResults(
      { rows: [{ spend_24h: '200', spend_baseline: '600', materiality_usd: '50', has_history: true }] },
      { rows: [{ id: 'alert-1' }] },
    );
    expect(await detectSpendSpike('user-1')).toBe(1);
  });

  it('does not fire when ratio < 2', async () => {
    queueQueryResults(
      { rows: [{ spend_24h: '150', spend_baseline: '600', materiality_usd: '50', has_history: true }] }, // 1.5×
    );
    const count = await detectSpendSpike('user-1');
    expect(count).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(1); // no INSERT
  });

  it('does not fire when 24h spend is below materiality threshold', async () => {
    // Ratio is infinite (baseline 0) but spend is $5 — below $50 threshold
    queueQueryResults(
      { rows: [{ spend_24h: '5', spend_baseline: '0', materiality_usd: '50', has_history: true }] },
    );
    const count = await detectSpendSpike('user-1');
    expect(count).toBe(0);
  });

  it('does not fire when history does not cover the 7-day window', async () => {
    queueQueryResults(
      { rows: [{ spend_24h: '500', spend_baseline: '0', materiality_usd: '50', has_history: false }] },
    );
    const count = await detectSpendSpike('user-1');
    expect(count).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('returns 0 on cooldown/dedup hit (INSERT returns no rows)', async () => {
    queueQueryResults(
      { rows: [{ spend_24h: '300', spend_baseline: '600', materiality_usd: '50', has_history: true }] },
      { rows: [] }, // recent spend_spike exists — cooldown suppressed the insert
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

    const params = (mockQuery.mock.calls[1] as unknown[])[1] as unknown[];
    expect(params[4] as string).toMatch(/^treasury_floor:w-1:/);
    // Cooldown is scoped per wallet
    expect(params[6]).toBe('wallet_id');
    expect(params[7]).toBe('w-1');
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

  it('inserts alert when 24h gas is 5x+ the prior 6-day daily average', async () => {
    queueQueryResults(
      { rows: [{ gas_24h: '15', gas_baseline: '12', has_history: true }] }, // avg = 2/day, ratio 7.5
      { rows: [{ id: 'alert-3' }] },
    );

    const count = await detectUnusualGas('user-1');
    expect(count).toBe(1);

    const params = (mockQuery.mock.calls[1] as unknown[])[1] as unknown[];
    expect(params[4] as string).toMatch(/^unusual_gas:user-1:/);
    const evidence = JSON.parse(params[3] as string) as { daily_avg: number; spike_ratio: number };
    expect(evidence.daily_avg).toBe(2);
    expect(evidence.spike_ratio).toBe(7.5);
  });

  it('fires at 5x — reachable now that the baseline excludes the last 24h', async () => {
    // Old 7-day-inclusive math: (6 + 5) / 7 = 1.57 → 3.2×, would never fire.
    queueQueryResults(
      { rows: [{ gas_24h: '5', gas_baseline: '6', has_history: true }] }, // avg = 1/day, ratio 5
      { rows: [{ id: 'alert-3' }] },
    );
    expect(await detectUnusualGas('user-1')).toBe(1);
  });

  it('does not fire when sub-$1 gas (noise guard)', async () => {
    queueQueryResults(
      { rows: [{ gas_24h: '0.50', gas_baseline: '0.06', has_history: true }] },
    );
    const count = await detectUnusualGas('user-1');
    expect(count).toBe(0);
  });

  it('does not fire when ratio < 5', async () => {
    queueQueryResults(
      { rows: [{ gas_24h: '5', gas_baseline: '30', has_history: true }] }, // avg = 5, ratio = 1
    );
    const count = await detectUnusualGas('user-1');
    expect(count).toBe(0);
  });

  it('does not fire with a zero baseline (no divide-by-zero)', async () => {
    queueQueryResults(
      { rows: [{ gas_24h: '20', gas_baseline: '0', has_history: true }] },
    );
    const count = await detectUnusualGas('user-1');
    expect(count).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does not fire when history does not cover the 7-day window', async () => {
    queueQueryResults(
      { rows: [{ gas_24h: '20', gas_baseline: '1', has_history: false }] },
    );
    const count = await detectUnusualGas('user-1');
    expect(count).toBe(0);
  });
});
