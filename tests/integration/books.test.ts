// Integration: src/books/query.ts getPnlSummary against real Postgres.
// See tests/integration/helpers/db.ts for how to run.
import { it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassification,
  insertClassifiedEvent,
} from './helpers/db.js';
import { getPnlSummary } from '../../src/books/query.js';

describeDb('getPnlSummary (integration)', () => {
  useIntegrationDb();

  it('nets revenue − expenses − gas, nets refunds against their category, excludes internal/treasury', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const ev = (o: Omit<Parameters<typeof insertClassifiedEvent>[0], 'wallet'>) =>
      insertClassifiedEvent({ wallet, ...o });

    await ev({ direction: 'in', label: 'revenue', amount: 100, usdValue: 100 });
    // Customer refund: revenue-labelled money going OUT reduces revenue
    await ev({ direction: 'out', label: 'revenue', amount: 10, usdValue: 10 });
    await ev({ direction: 'in', label: 'x402_income', amount: 20, usdValue: null }); // USDC 1:1 fallback
    await ev({ direction: 'out', label: 'expense', amount: 40, usdValue: 40 });
    // Vendor refund: expense-labelled money coming IN reduces expenses
    await ev({ direction: 'in', label: 'expense', amount: 5, usdValue: 5 });
    await ev({ direction: 'out', label: 'gas', asset: 'ETH', amount: 0.001, usdValue: 2 });
    // Excluded from P&L
    await ev({ direction: 'out', label: 'internal_transfer', amount: 1000, usdValue: 1000 });
    await ev({ direction: 'in', label: 'treasury', amount: 500, usdValue: 500 });
    await ev({ direction: 'in', label: 'refund', amount: 3, usdValue: 3 });
    await ev({ direction: 'in', label: 'unknown', amount: 7, usdValue: 7 });
    // Outside the 7-day window
    await ev({ direction: 'in', label: 'revenue', amount: 50, usdValue: 50, at: '10 days' });

    // Superseded classification must not count; its active one is internal
    const e = await insertEvent({ wallet, direction: 'in', amount: 999, usdValue: 999 });
    await insertClassification({ eventId: e.id, userId: user.id, label: 'revenue', superseded: true });
    await insertClassification({ eventId: e.id, userId: user.id, label: 'internal_transfer' });

    const pnl = await getPnlSummary(user.id, 7);
    expect(pnl.period_days).toBe(7);
    expect(pnl.revenue_usdc).toBeCloseTo(110, 6); // 100 − 10 + 20
    expect(pnl.expenses_usdc).toBeCloseTo(35, 6); // 40 − 5
    expect(pnl.gas_usdc).toBeCloseTo(2, 6);
    expect(pnl.net_usdc).toBeCloseTo(73, 6);      // 110 − 35 − 2
    expect(pnl.unknown_count).toBe(1);
  });

  it('a refund-only period produces negative category totals and a net that reflects them', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await insertClassifiedEvent({ wallet, direction: 'out', label: 'revenue', amount: 30, usdValue: 30 });
    await insertClassifiedEvent({ wallet, direction: 'in', label: 'expense', amount: 12, usdValue: 12 });

    const pnl = await getPnlSummary(user.id, 1);
    expect(pnl.revenue_usdc).toBeCloseTo(-30, 6);
    expect(pnl.expenses_usdc).toBeCloseTo(-12, 6);
    expect(pnl.net_usdc).toBeCloseTo(-18, 6); // −30 − (−12) − 0
  });

  it('is scoped to the user and returns zeros for an empty period', async () => {
    const { user } = await seedUserWithWallet();
    const other = await seedUserWithWallet();
    await insertClassifiedEvent({ wallet: other.wallet, direction: 'in', label: 'revenue', amount: 100, usdValue: 100 });

    const pnl = await getPnlSummary(user.id, 30);
    expect(pnl).toEqual({
      period_days: 30, revenue_usdc: 0, expenses_usdc: 0, gas_usdc: 0, net_usdc: 0, unknown_count: 0, pending_count: 0,
    });
  });
});
