import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/db.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn() },
}));

import * as db from '../../src/db.js';
import { generateDailyBrief, generateWeeklyBrief } from '../../src/briefs/generate.js';
import { getPnlSummary } from '../../src/books/query.js';

const mockQuery = db.query as unknown as Mock<(text: string, params?: unknown[]) => Promise<unknown>>;

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

// Open unknown transfers across question groups (getOpenUnknowns)
const open = (count: number, small = 0, smallUsd: string | null = null) => ({
  rows: [{ count, small_count: small, small_usd: smallUsd }],
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
    const sql = mockQuery.mock.calls[0][0];
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

// Brief query order: P&L for the period, P&L for twice the period, open unknowns, top
// counterparties, material activity, ledger status. By default there is some activity
// and the books are proven, so the full brief renders.
const activity = (count: number) => ({ rows: [{ count }] });
const ledger = (...statuses: string[]) => ({
  rows: statuses.map((status, i) => ({
    address: `0x${i}`, label: null, status, incomplete_since_at: null, incomplete_since_block: null, last_checked_at: null,
  })),
});
function queueBrief(
  pnl: { rows: unknown[] }, pnl2: { rows: unknown[] }, openRes: { rows: unknown[] }, top: { rows: unknown[] },
  material = activity(1), ledgerRes = ledger('complete'),
) {
  queueResults(pnl, pnl2, openRes, top, material, ledgerRes);
}

describe('generateDailyBrief', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prints signed revenue, expenses, gas and net', async () => {
    // Query order: getPnlSummary(1d), getPnlSummary(2d), open unknowns, topCounterparties
    queueBrief(
      pnlRow('450', '23.50', '0.80'),   // today
      pnlRow('900', '47', '1.60'),       // 2d total
      open(2),                           // open unknowns
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
    queueBrief(
      pnlRow('10', '60', '0'),
      pnlRow('20', '120', '0'),
      open(0),
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(lineValue(brief, 'Net')).toBe('-$50.00');
  });

  it('includes gas in net', async () => {
    queueBrief(
      pnlRow('100', '40', '10'),
      pnlRow('100', '40', '10'),
      open(0),
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(lineValue(brief, 'Net')).toBe('+$50.00');
  });

  it('compares against yesterday-only figures', async () => {
    queueBrief(
      pnlRow('150', '50', '0'),   // today
      pnlRow('250', '100', '0'),  // 2d → yesterday: rev 100, exp 50
      open(0),
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('+50% revenue');
    expect(brief).toContain('+0% expenses');
  });

  it('includes unknown count nudge when unknowns exist', async () => {
    queueBrief(
      pnlRow('100', '0', '0'),
      pnlRow('100', '0', '0'),
      open(5),
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('5 transfers need context.');
    expect(brief).not.toContain('/review');
  });

  it('lists small unknowns that never got their own question', async () => {
    queueBrief(pnlRow('0', '0', '0'), pnlRow('0', '0', '0'), open(3, 2, '4.20'), { rows: [] });
    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('3 transfers need context. 2 of them are under $10.00 ($4.20 in total), so I have not pinged you about them.');
  });

  it('shows the provisional part beside revenue and says how many labels are guesses', async () => {
    queueBrief(
      { rows: [{ revenue_usdc: '450', expenses_usdc: '0', gas_usdc: '0', revenue_provisional_usdc: '300', provisional_count: 2 }] },
      pnlRow('450', '0', '0'),
      open(0),
      { rows: [] },
    );
    const brief = await generateDailyBrief('user-1');
    expect(brief.split('\n').find((l) => l.startsWith('Revenue'))).toContain('incl. $300.00 provisional');
    expect(brief).toContain('2 labels are my best guess, not confirmed by you or a rule.');
  });

  it('omits unknown nudge when no unknowns', async () => {
    queueBrief(
      pnlRow('100', '0', '0'),
      pnlRow('100', '0', '0'),
      open(0),
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).not.toContain('/review');
  });

  it('includes top counterparties when present', async () => {
    queueBrief(
      pnlRow('500', '50', '1'),
      pnlRow('1000', '100', '2'),
      open(0),
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
    queueBrief(
      pnlRow('500', '50', '1'),
      pnlRow('1000', '100', '2'),
      open(0),
      { rows: [{ address: '0xABCDEF1234567890abcdef', name: 'evil_*name[`', total_usdc: '300' }] },
    );

    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('evil\\_\\*name\\[\\`');
    expect(brief).not.toContain('evil_*name');
  });

  it('sends one line on a quiet day with nothing open', async () => {
    queueBrief(pnlRow('0', '0', '0'), pnlRow('0', '0', '0'), open(0), { rows: [] }, activity(0));
    const brief = await generateDailyBrief('user-1');
    expect(brief.split('\n').slice(1).join('\n').trim()).toBe(
      'Quiet day yesterday. No revenue, expenses or material activity. Your books are up to date.',
    );
    expect(brief).not.toContain('Revenue ');
  });

  it('on a quiet day with open questions, makes them the focus and does not say up to date', async () => {
    queueBrief(pnlRow('0', '0', '0'), pnlRow('0', '0', '0'), open(3, 2, '4.20'), { rows: [] }, activity(0));
    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('Quiet day yesterday. No revenue, expenses or material activity.');
    expect(brief).not.toContain('up to date');
    expect(brief).toContain('3 transfers need context.');
  });

  it('does not call a day quiet when a transfer moved money, even if it is not revenue or expense', async () => {
    queueBrief(pnlRow('0', '0', '0'), pnlRow('0', '0', '0'), open(0), { rows: [] }, activity(1));
    const brief = await generateDailyBrief('user-1');
    expect(brief).not.toContain('Quiet day');
    expect(lineValue(brief, 'Net')).toBe('+$0.00');
  });

  it('does not say up to date while a wallet has not been checked against the chain', async () => {
    queueBrief(pnlRow('0', '0', '0'), pnlRow('0', '0', '0'), open(0), { rows: [] }, activity(0), ledger('complete', 'unknown'));
    const brief = await generateDailyBrief('user-1');
    expect(brief).toContain('Quiet day yesterday.');
    expect(brief).not.toContain('up to date');
  });

  it('leads with incomplete books before the figures', async () => {
    queueBrief(pnlRow('100', '0', '0'), pnlRow('100', '0', '0'), open(0), { rows: [] }, activity(1), ledger('incomplete', 'complete'));
    const brief = await generateDailyBrief('user-1');
    const lines = brief.split('\n');
    const leadAt = lines.findIndex((l) => l.startsWith('Your books are incomplete: one wallet has'));
    const revenueAt = lines.findIndex((l) => l.includes('Revenue'));
    expect(leadAt).toBeGreaterThan(0);
    expect(leadAt).toBeLessThan(revenueAt);
  });

  it('does not throw on an invalid timezone', async () => {
    queueBrief(
      pnlRow('0', '0', '0'),
      pnlRow('0', '0', '0'),
      open(0),
      { rows: [] },
    );

    const brief = await generateDailyBrief('user-1', 'Not/AZone');
    expect(brief).toContain('Daily brief');
  });
});

describe('generateWeeklyBrief', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes week-over-week comparison with signed values', async () => {
    queueBrief(
      pnlRow('2450', '180', '3.20'),   // this week (7d)
      pnlRow('4500', '400', '6'),       // 14d total
      open(3),
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
    queueBrief(
      pnlRow('10', '60', '0'),
      pnlRow('10', '60', '0'),
      open(0),
      { rows: [] },
    );

    const brief = await generateWeeklyBrief('user-1');
    expect(lineValue(brief, 'Net')).toBe('-$50.00');
  });

  it('sends one line on a quiet week', async () => {
    queueBrief(pnlRow('0', '0', '0'), pnlRow('0', '0', '0'), open(0), { rows: [] }, activity(0));
    const brief = await generateWeeklyBrief('user-1');
    expect(brief).toContain('Quiet week. No revenue, expenses or material activity. Your books are up to date.');
  });

  it('formats the week date range correctly', async () => {
    queueBrief(
      pnlRow('0', '0', '0'),
      pnlRow('0', '0', '0'),
      open(0),
      { rows: [] },
    );

    const brief = await generateWeeklyBrief('user-1', 'America/New_York');
    // Should contain a date range like "Jan 8–Jan 15"
    expect(brief).toMatch(/Week of \w+ \d+–\w+ \d+|Week of \w+ \d+–\d+/);
  });
});
