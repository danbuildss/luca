import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn() },
}));

import * as db from '../../src/db.js';
import { generateDailyBrief, generateWeeklyBrief } from '../../src/briefs/generate.js';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

// Returns rows in call order
function queueResults(...results: Array<{ rows: unknown[] }>) {
  let i = 0;
  mockQuery.mockImplementation(() => Promise.resolve(results[i++ % results.length]));
}

// Shared PnL response helper
const pnlRow = (rev: string, exp: string, gas: string) => ({
  rows: [{ label: 'revenue', direction: 'in', event_count: 1, total_usdc: rev },
         { label: 'expense', direction: 'out', event_count: 1, total_usdc: exp },
         { label: 'gas',     direction: 'out', event_count: 1, total_usdc: gas }],
});

describe('generateDailyBrief', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes revenue, expenses, gas and net in the output', async () => {
    // getPnlSummary calls getBooksSummary (1 query each × 2 periods) + unknownCount + topCounterparties
    queueResults(
      pnlRow('450', '23.50', '0.80'),   // today  — getBooksSummary(1d)
      pnlRow('900', '47', '1.60'),       // 2d total — getBooksSummary(2d)
      { rows: [{ cnt: '2' }] },          // unknownCount
      { rows: [] },                      // topCounterparties
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('Revenue');
    expect(brief).toContain('450.00');
    expect(brief).toContain('Expenses');
    expect(brief).toContain('23.50');
    expect(brief).toContain('Gas');
    expect(brief).toContain('Net');
  });

  it('includes unknown count nudge when unknowns exist', async () => {
    queueResults(
      pnlRow('100', '0', '0'),
      pnlRow('100', '0', '0'),
      { rows: [{ cnt: '5' }] },
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('5 unknowns');
    expect(brief).toContain('/review');
  });

  it('omits unknown nudge when no unknowns', async () => {
    queueResults(
      pnlRow('100', '0', '0'),
      pnlRow('100', '0', '0'),
      { rows: [{ cnt: '0' }] },
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).not.toContain('/review');
  });

  it('includes top counterparties when present', async () => {
    queueResults(
      pnlRow('500', '50', '1'),
      pnlRow('1000', '100', '2'),
      { rows: [{ cnt: '0' }] },
      {
        rows: [
          { address: '0xABCDEF1234567890abcdef', name: 'Acme Corp', total_usdc: '300' },
          { address: '0x9876543210abcdef9876', name: null, total_usdc: '200' },
        ],
      },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('Top counterparties');
    expect(brief).toContain('Acme Corp');
  });
});

describe('generateWeeklyBrief', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes week-over-week comparison', async () => {
    queueResults(
      pnlRow('2450', '180', '3.20'),   // this week (7d)
      pnlRow('4500', '400', '6'),       // 14d total
      { rows: [{ cnt: '3' }] },
      { rows: [] },
    );

    const brief = await generateWeeklyBrief('user-1');
    expect(brief).toContain('Week of');
    expect(brief).toContain('2,450.00');
    expect(brief).toContain('prior week');
  });

  it('formats the week date range correctly', async () => {
    queueResults(
      pnlRow('0', '0', '0'),
      pnlRow('0', '0', '0'),
      { rows: [{ cnt: '0' }] },
      { rows: [] },
    );

    const brief = await generateWeeklyBrief('user-1');
    // Should contain a date range like "Jan 8–15"
    expect(brief).toMatch(/Week of \w+ \d+–\w+ \d+|Week of \w+ \d+–\d+/);
  });
});
