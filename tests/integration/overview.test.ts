// Integration: src/books/overview.ts against real Postgres.
// See tests/integration/helpers/db.ts for how to run.
import { it, expect, vi } from 'vitest';

vi.mock('../../src/ingestion/price.js', () => ({
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
  enrichUsdValue: vi.fn(),
}));

import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertClassifiedEvent, sql, addr,
} from './helpers/db.js';
import { getOverview } from '../../src/books/overview.js';

describeDb('getOverview (integration)', () => {
  useIntegrationDb();

  it('counts transactions and totals internal and unknown money, ignoring spam', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const own = addr();
    await insertClassifiedEvent({ wallet, direction: 'in', counterparty: own, amount: 49.44, usdValue: 49.44, label: 'internal_transfer' });
    await insertClassifiedEvent({ wallet, direction: 'out', counterparty: own, amount: 49, usdValue: 49, label: 'internal_transfer' });
    await insertClassifiedEvent({ wallet, direction: 'in', amount: 13.71, usdValue: 13.71, label: 'unknown' });
    await insertClassifiedEvent({ wallet, direction: 'in', amount: 900, usdValue: 900, label: 'unknown', asset: 'SCAM' });

    const o = await getOverview(user.id, 30);
    expect(o.transaction_count).toBe(3);
    expect(o.internal_usd).toBeCloseTo(98.44);
    expect(o.unknown_usd).toBeCloseTo(13.71);
    expect(o.needs_context.count).toBe(1);
    expect(o.needs_context.examples[0]).toMatchObject({ direction: 'in', amount: '13.71' });
    expect(o.pnl.revenue_usdc).toBe(0);
  });

  it('flags a first-time payee but not an address paid before', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const vendor = addr();
    const designer = addr();
    await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, amount: 50, label: 'expense', at: '20 days' });
    await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, amount: 60, label: 'expense', at: '2 days' });
    await insertClassifiedEvent({ wallet, direction: 'out', counterparty: designer, amount: 620, label: 'expense', at: '1 day' });

    const o = await getOverview(user.id, 30);
    expect(o.first_time_payments.map((p) => p.counterparty)).toEqual([designer]);
  });

  it('compares the last week of spending with the usual weekly rate once there is history', async () => {
    const { user, wallet } = await seedUserWithWallet();
    for (const at of ['30 days', '23 days', '16 days', '9 days']) {
      await insertClassifiedEvent({ wallet, direction: 'out', amount: 100, label: 'expense', at });
    }
    await insertClassifiedEvent({ wallet, direction: 'out', amount: 180, label: 'expense', at: '1 day' });

    const o = await getOverview(user.id, 30);
    expect(o.spend_vs_usual).not.toBeNull();
    expect(o.spend_vs_usual!.usual_weekly_usd).toBeCloseTo(100);
    expect(o.spend_vs_usual!.ratio).toBeCloseTo(1.8);
  });

  it('reports no spending comparison without four weeks of history', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await insertClassifiedEvent({ wallet, direction: 'out', amount: 180, label: 'expense', at: '1 day' });
    expect((await getOverview(user.id, 30)).spend_vs_usual).toBeNull();
  });

  it('values cash at live prices', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await sql(
      `INSERT INTO balance_snapshots (wallet_id, user_id, asset, balance, snapshot_at)
       VALUES ($1, $2, 'USDC', 0.44, NOW()), ($1, $2, 'ETH', 0.001, NOW())`,
      [wallet.id, user.id],
    );
    const o = await getOverview(user.id, 30);
    expect(o.cash_usd).toBeCloseTo(4.44);
    expect(o.cash_incomplete).toBe(false);
  });
});
