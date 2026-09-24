// Integration: on-chain re-pricing, swap prices, USDC peg alerts, figure breakdowns and
// saved answers (PR 5), against real Postgres. On-chain reads are stubbed; their decoding
// is covered in tests/pricing/onchain.test.ts.
import { it, expect, vi, beforeEach, describe } from 'vitest';

const chain = vi.hoisted(() => ({
  eth: 2500 as number | null,
  bnkr: { usd: 0.004, kind: 'twap' } as { usd: number; kind: 'twap' | 'spot' } | null,
  usdc: 1 as number | null,
  reads: 0,
}));
vi.mock('../../src/pricing/onchain.js', () => ({
  ethUsdAt: () => { chain.reads++; return Promise.resolve(chain.eth); },
  bnkrUsdAt: () => { chain.reads++; return Promise.resolve(chain.bnkr); },
  usdcUsdAt: () => Promise.resolve(chain.usdc),
}));
vi.mock('../../src/classification/llm.js', () => ({
  classifyWithLlmDetailed: vi.fn((events: Array<{ id: string }>) => Promise.resolve({
    results: new Map(events.map((e) => [e.id, { label: 'revenue', confidence: 0.7, method: 'model', evidence: 'stub' }])),
    failures: new Map(),
  })),
}));

import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassifiedEvent, sql,
} from './helpers/db.js';
import { upgradePrices, priceSwaps } from '../../src/ingestion/reprice.js';
import { checkUsdcPeg } from '../../src/pricing/peg.js';
import { classifyPendingEvents } from '../../src/classification/engine.js';
import { getPnlSummary } from '../../src/books/query.js';
import { getFigureBreakdown } from '../../src/books/breakdown.js';
import { saveAnswerTrace, getPreviousAnswers } from '../../src/agent/traces.js';

type Priced = { usd_value: string | null; price_source: string | null; price_ref: string | null };
async function priceOf(eventId: string): Promise<Priced> {
  const rows = await sql<Priced>(
    `SELECT usd_value::text, price_source, price_ref FROM normalized_events WHERE id = $1`, [eventId],
  );
  return rows[0];
}

async function atBlock(eventId: string, block: number, source: string | null, usd: number | null): Promise<void> {
  await sql(
    `UPDATE normalized_events SET block_number = $2, price_source = $3, usd_value = $4 WHERE id = $1`,
    [eventId, block, source, usd],
  );
}

describeDb('prices and traceable answers (integration)', () => {
  useIntegrationDb();
  beforeEach(() => {
    chain.eth = 2500;
    chain.bnkr = { usd: 0.004, kind: 'twap' };
    chain.usdc = 1;
    chain.reads = 0;
  });

  describe('re-pricing history on chain', () => {
    it('replaces CoinGecko daily and missing BNKR prices, and never touches labels', async () => {
      const { wallet } = await seedUserWithWallet();
      const eth = await insertClassifiedEvent({ wallet, direction: 'out', asset: 'ETH', amount: 0.5, label: 'expense', method: 'counterparty', source: 'user' });
      await atBlock(eth.id, 51_000_000, 'coingecko_daily', 1_900);
      const bnkr = await insertClassifiedEvent({ wallet, direction: 'in', asset: 'BNKR', amount: 25_000, label: 'revenue' });
      await atBlock(bnkr.id, 51_000_100, 'unavailable', null);
      const usdc = await insertClassifiedEvent({ wallet, direction: 'in', amount: 10, label: 'revenue' });
      await atBlock(usdc.id, 51_000_200, 'stable', 10);

      expect(await upgradePrices('key')).toBe(2);

      expect(await priceOf(eth.id)).toEqual({ usd_value: '1250', price_source: 'chainlink', price_ref: 'Chainlink ETH/USD $2500.00 at block 51,000,000' });
      expect(await priceOf(bnkr.id)).toMatchObject({ usd_value: '100', price_source: 'pool_twap' });
      expect(await priceOf(usdc.id)).toMatchObject({ price_source: 'stable' });
      const label = await sql<{ id: string }>(`SELECT id FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`, [eth.id]);
      expect(label[0].id).toBe(eth.classificationId);
    });

    it('tries a transfer the chain cannot price at most once a day', async () => {
      const { wallet } = await seedUserWithWallet();
      const eth = await insertEvent({ wallet, direction: 'out', asset: 'ETH', amount: 1 });
      await atBlock(eth.id, 51_000_000, 'coingecko_daily', 2_000);
      chain.eth = null;

      expect(await upgradePrices('key')).toBe(0);
      expect(chain.reads).toBe(1);
      expect(await priceOf(eth.id)).toMatchObject({ price_source: 'coingecko_daily', usd_value: '2000' });
      await upgradePrices('key');
      expect(chain.reads).toBe(1);
    });
  });

  it('BNKR bought in a swap is worth exactly what was paid for it', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const hash = `0x${'5'.repeat(64)}`;
    await insertEvent({ wallet, hash, direction: 'out', amount: 100, usdValue: 100, sourceKey: 'log:1' });
    const bnkr = await insertEvent({ wallet, hash, direction: 'in', asset: 'BNKR', amount: 20_000, sourceKey: 'log:2' });
    await atBlock(bnkr.id, 51_000_000, 'pool_twap', 83.5);
    await classifyPendingEvents(user.id);

    expect(await priceSwaps()).toBe(1);
    const p = await priceOf(bnkr.id);
    expect(p).toMatchObject({ usd_value: '100.000', price_source: 'swap' });
    expect(p.price_ref).toBe(`Your swap in ${hash.slice(0, 10)}…: $0.005000 per BNKR`);
    expect(await priceSwaps()).toBe(0);
  });

  describe('USDC peg', () => {
    async function holder() {
      const s = await seedUserWithWallet();
      await sql(
        `INSERT INTO balance_snapshots (wallet_id, user_id, asset, balance, snapshot_at) VALUES ($1, $2, 'USDC', 50, NOW())`,
        [s.wallet.id, s.user.id],
      );
      return s;
    }

    it('alerts each USDC holder once a day when USDC is more than 2% off $1', async () => {
      const a = await holder();
      const b = await holder();
      await seedUserWithWallet(); // holds no USDC
      chain.usdc = 0.97;
      await checkUsdcPeg('key');
      await checkUsdcPeg('key');
      const alerts = await sql<{ user_id: string; message: string }>(
        `SELECT user_id, message FROM alerts WHERE type = 'usdc_depeg' ORDER BY user_id`,
      );
      expect(alerts.map((x) => x.user_id).sort()).toEqual([a.user.id, b.user.id].sort());
      expect(alerts[0].message).toContain('Chainlink shows USDC at $0.9700');
    });

    it('stays quiet within 2%', async () => {
      await holder();
      chain.usdc = 0.985;
      await checkUsdcPeg('key');
      expect(await sql(`SELECT 1 FROM alerts WHERE type = 'usdc_depeg'`)).toHaveLength(0);
    });
  });

  describe('figure breakdown', () => {
    it('lists the transactions behind each figure, and they add up to the totals exactly', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = (o: Omit<Parameters<typeof insertClassifiedEvent>[0], 'wallet'>) => insertClassifiedEvent({ wallet, ...o });
      await ev({ direction: 'in', label: 'revenue', amount: 1200, usdValue: 1200, method: 'counterparty' });
      await ev({ direction: 'in', label: 'revenue', amount: 300, usdValue: 300 }); // provisional
      await ev({ direction: 'out', label: 'refund', amount: 50, usdValue: 50 });
      await ev({ direction: 'in', label: 'x402_income', amount: 20 }); // USDC, $1 each
      await ev({ direction: 'out', label: 'expense', amount: 400, usdValue: 400 });
      await ev({ direction: 'in', label: 'refund', amount: 25, usdValue: 25 });
      await ev({ direction: 'out', label: 'gas', asset: 'ETH', amount: 0.0001, usdValue: 0.25 });
      await ev({ direction: 'out', label: 'swap', amount: 100, usdValue: 100 });
      await ev({ direction: 'in', label: 'revenue', amount: 999, usdValue: 999, at: '40 days' });
      const other = await seedUserWithWallet();
      await insertClassifiedEvent({ wallet: other.wallet, direction: 'in', label: 'revenue', amount: 5000, usdValue: 5000 });

      const pnl = await getPnlSummary(user.id, 30);
      const revenue = await getFigureBreakdown(user.id, 'revenue', 30);
      const expenses = await getFigureBreakdown(user.id, 'expenses', 30);
      const gas = await getFigureBreakdown(user.id, 'gas', 30);

      expect(revenue.total_usd).toBeCloseTo(pnl.revenue_usdc, 9);
      expect(revenue.total_usd).toBeCloseTo(1470, 9); // 1200 + 300 − 50 + 20
      expect(expenses.total_usd).toBeCloseTo(pnl.expenses_usdc, 9);
      expect(gas.total_usd).toBeCloseTo(pnl.gas_usdc, 9);
      expect(revenue.count).toBe(4);
      expect(revenue.rows[0]).toMatchObject({ usd: '1200', label: 'revenue', status: 'confirmed' });
      expect(revenue.rows[0].basescan).toBe(`https://basescan.org/tx/${revenue.rows[0].hash}`);
      const h = revenue.rows[0].hash;
      expect(revenue.rows[0]).toMatchObject({
        amount_display: '1,200 USDC',
        usd_display: '$1,200.00',
        link: `[${h.slice(0, 6)}…${h.slice(-4)}](https://basescan.org/tx/${h})`,
      });
      expect(gas.rows[0]).toMatchObject({ amount_display: '0.0001 ETH', usd_display: '$0.25' });
      expect(revenue.rows.find((r) => r.label === 'refund')?.usd).toBe('-50');

      const provisional = await getFigureBreakdown(user.id, 'provisional', 30);
      // Every fixture labeled by the AI (the default method) is a guess, counted at its USD value:
      // 300 + 50 + 20 + 400 + 25 + 0.25 + 100
      expect(provisional.total_usd).toBeCloseTo(895.25, 9);
      expect(provisional.count).toBe(7);
      expect((await getFigureBreakdown(user.id, 'swaps', 30)).total_usd).toBe(100);

      const short = await getFigureBreakdown(user.id, 'revenue', 30, 2);
      expect(short).toMatchObject({ count: 4, truncated: true });
      expect(short.rows).toHaveLength(2);
      expect(short.total_usd).toBeCloseTo(1470, 9);
    });
  });

  it('saves each answer with the tool calls behind it, visible only to that operator', async () => {
    const a = await seedUserWithWallet();
    const b = await seedUserWithWallet();
    await saveAnswerTrace({
      userId: a.user.id, question: 'What does the last month look like?', answer: 'Revenue $1,470.00 ...',
      tools: [{ name: 'get_overview', args: { period_days: 30 } }],
    });
    await saveAnswerTrace({ userId: b.user.id, question: 'hi', answer: 'hello', tools: [] });

    const mine = await getPreviousAnswers(a.user.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      question: 'What does the last month look like?',
      tools: [{ name: 'get_overview', args: { period_days: 30 } }],
    });
  });
});
