import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn() },
}));

import * as db from '../../src/db.js';
import { generateDailyBrief, generateWeeklyBrief } from '../../src/briefs/generate.js';
import { getPnlSummary } from '../../src/books/query.js';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

// Returns rows in call order
function queueResults(...results: Array<{ rows: unknown[] }>) {
  let i = 0;
  mockQuery.mockImplementation(() => Promise.resolve(results[i++ % results.length]));
}

// Shared PnL response helper — getPnlSummary runs one aggregate query that
// returns already direction-netted totals
const pnlRow = (rev: string, exp: string, gas: string, unknown = 0) => ({
  rows: [{ revenue_usdc: rev, expenses_usdc: exp, gas_usdc: gas, unknown_count: unknown }],
});

// Extract the amount printed on a given brief line, e.g. "Net" → "-$50.00"
function lineValue(brief: string, label: string): string | undefined {
  const line = brief.split('\n').find((l) => l.includes(label));
  return line?.match(/[+-]\$[\d,]+\.\d{2}/)?.[0];
}

describe('getPnlSummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes net as revenue - expenses - gas', async () => {
    queueResults(pnlRow('100', '30', '5', 2));
    const pnl = await getPnlSummary('user-1', 7);
    expect(pnl.revenue_usdc).toBe(100);
    expect(pnl.expenses_usdc).toBe(30);
    expect(pnl.gas_usdc).toBe(5);
    expect(pnl.net_usdc).toBe(65);
    expect(pnl.unknown_count).toBe(2);
  });

  it('nets refunds by direction in SQL', async () => {
    queueResults(pnlRow('0', '0', '0'));
    await getPnlSummary('user-1', 7);
    const sql = mockQuery.mock.calls[0][0] as string;
    // revenue going out and expenses coming in are subtracted
    expect(sql).toMatch(/direction = 'out' THEN -/);
    expect(sql).toMatch(/direction = 'in' THEN -/);
  });

  it('treats empty periods (NULL sums) as zero', async () => {
    queueResults(pnlRow(null as unknown as string, null as unknown as string, null as unknown as string));
    const pnl = await getPnlSummary('user-1', 1);
    expect(pnl.net_usdc).toBe(0);
  });
});

describe('generateDailyBrief', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prints signed revenue, expenses, gas and net', async () => {
    // Query order: getPnlSummary(1d), getPnlSummary(2d), unknownCount, topCounterparties
    queueResults(
      pnlRow('450', '23.50', '0.80'),   // today
      pnlRow('900', '47', '1.60'),       // 2d total
      { rows: [{ cnt: '2' }] },          // unknownCount
      { rows: [] },                      // topCounterparties
    );

    const brief = await generateDailyBrief('user-1');
    expect(lineValue(brief, 'Revenue')).toBe('+$450.00');
    expect(lineValue(brief, 'Expenses')).toBe('-$23.50');
    expect(lineValue(brief, 'Gas')).toBe('-$0.80');
    // 450 - 23.50 - 0.80
    expect(lineValue(brief, 'Net')).toBe('+$425.70');
  });

  it('shows a negative net with a minus sign', async () => {
    queueResults(
      pnlRow('10', '60', '0'),
      pnlRow('20', '120', '0'),
      { rows: [{ cnt: '0' }] },
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(lineValue(brief, 'Net')).toBe('-$50.00');
  });

  it('includes gas in net', async () => {
    queueResults(
      pnlRow('100', '40', '10'),
      pnlRow('100', '40', '10'),
      { rows: [{ cnt: '0' }] },
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(lineValue(brief, 'Net')).toBe('+$50.00');
  });

  it('compares against yesterday-only figures', async () => {
    queueResults(
      pnlRow('150', '50', '0'),   // today
      pnlRow('250', '100', '0'),  // 2d → yesterday: rev 100, exp 50
      { rows: [{ cnt: '0' }] },
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('+50% revenue');
    expect(brief).toContain('+0% expenses');
  });

  it('includes unknown count nudge when unknowns exist', async () => {
    queueResults(
      pnlRow('100', '0', '0'),
      pnlRow('100', '0', '0'),
      { rows: [{ cnt: '5' }] },
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('5 unknown transfers need context');
    expect(brief).not.toContain('/review');
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
    expect(brief).toContain('$300.00');
    expect(brief).toContain('0x9876…9876');
  });

  it('escapes Markdown in user-set counterparty names', async () => {
    queueResults(
      pnlRow('500', '50', '1'),
      pnlRow('1000', '100', '2'),
      { rows: [{ cnt: '0' }] },
      { rows: [{ address: '0xABCDEF1234567890abcdef', name: 'evil_*name[`', total_usdc: '300' }] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('evil\\_\\*name\\[\\`');
    expect(brief).not.toContain('evil_*name');
  });

  it('does not throw on an invalid timezone', async () => {
    queueResults(
      pnlRow('0', '0', '0'),
      pnlRow('0', '0', '0'),
      { rows: [{ cnt: '0' }] },
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1', 'Not/AZone');
    expect(brief).toContain('Daily brief');
  });
});

describe('generateWeeklyBrief', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes week-over-week comparison with signed values', async () => {
    queueResults(
      pnlRow('2450', '180', '3.20'),   // this week (7d)
      pnlRow('4500', '400', '6'),       // 14d total
      { rows: [{ cnt: '3' }] },
      { rows: [] },
    );

    const brief = await generateWeeklyBrief('user-1');
    expect(brief).toContain('Week of');
    expect(lineValue(brief, 'Revenue')).toBe('+$2,450.00');
    expect(lineValue(brief, 'Expenses')).toBe('-$180.00');
    expect(lineValue(brief, 'Gas')).toBe('-$3.20');
    // 2450 - 180 - 3.20
    expect(lineValue(brief, 'Net')).toBe('+$2,266.80');
    // prior week revenue = 4500 - 2450 = 2050 → +20%
    expect(brief).toContain('+20% vs prior week');
  });

  it('shows a negative weekly net with a minus sign', async () => {
    queueResults(
      pnlRow('10', '60', '0'),
      pnlRow('10', '60', '0'),
      { rows: [{ cnt: '0' }] },
      { rows: [] },
    );

    const brief = await generateWeeklyBrief('user-1');
    expect(lineValue(brief, 'Net')).toBe('-$50.00');
  });

  it('formats the week date range correctly', async () => {
    queueResults(
      pnlRow('0', '0', '0'),
      pnlRow('0', '0', '0'),
      { rows: [{ cnt: '0' }] },
      { rows: [] },
    );

    const brief = await generateWeeklyBrief('user-1', 'America/New_York');
    // Should contain a date range like "Jan 8–Jan 15"
    expect(brief).toMatch(/Week of \w+ \d+–\w+ \d+|Week of \w+ \d+–\d+/);
  });
});
