// Integration: "show me my recent transactions" lists every supported movement in the
// period grouped by on-chain transaction, says what it covers, and shows ready-made amounts
// and links. The Sep 27 failure: the model asked for unknowns only and the answer left out
// a swap from the same week.
import { it, expect, vi } from 'vitest';

vi.mock('../../src/ingestion/price.js', () => ({
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
  enrichUsdValue: vi.fn(),
}));

import { describeDb, useIntegrationDb, seedUserWithWallet, insertClassifiedEvent, insertEvent, addr, type WalletFx } from './helpers/db.js';
import { executeTool } from '../../src/agent/tools.js';
import type { Activity } from '../../src/books/activity.js';

const SWAP = `0x${'f5a2'.padEnd(64, '3')}`;
const INFLOW = `0x${'4586'.padEnd(64, '5')}`;

// The real swap of Sep 27: ETH out, BNKR in and its fee, three movements of one transaction
async function seedSwap(wallet: WalletFx, hash = SWAP, at = '3 hours'): Promise<void> {
  const router = addr();
  await insertClassifiedEvent({ wallet, hash, direction: 'out', counterparty: router, asset: 'ETH', amount: '0.0009', usdValue: 2.44, label: 'swap', at, sourceKey: 'external' });
  await insertClassifiedEvent({ wallet, hash, direction: 'in', counterparty: router, asset: 'BNKR', amount: '5475.54', usdValue: 2.44, label: 'swap', at, sourceKey: 'log:772' });
  await insertClassifiedEvent({ wallet, hash, direction: 'out', counterparty: null, asset: 'ETH', amount: '0.000000931502', usdValue: 0.0025, label: 'gas', at, sourceKey: 'gas' });
}

async function seedWeek() {
  const seeded = await seedUserWithWallet();
  const { wallet } = seeded;
  await seedSwap(wallet);
  // An unknown inflow, shown raw on Sep 27 as 0.001499703666736745 ETH
  await insertClassifiedEvent({ wallet, hash: INFLOW, direction: 'in', asset: 'ETH', amount: '0.001499703666736745', usdValue: 4.06, label: 'unknown', at: '1 hour' });
  // Outside the week
  await insertClassifiedEvent({ wallet, direction: 'in', asset: 'USDC', amount: 49.44, usdValue: 49.44, label: 'revenue', at: '10 days' });
  return seeded;
}

describeDb('recent activity (integration)', () => {
  useIntegrationDb();

  it('a swap with three movements under one hash is one transaction', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await seedSwap(wallet);
    const r = await executeTool(user.id, 'get_recent_activity', {}) as Activity;

    expect(r.covers).toMatchObject({ transactions: 1, movements: 3, listed_transactions: 1 });
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].movements.map((m) => [m.direction, m.amount_display, m.kind])).toEqual([
      ['out', '0.0009 ETH', 'transfer'],
      ['in', '5,475.54 BNKR', 'transfer'],
      ['out', '0.000000931502 ETH', 'fee'],
    ]);
  });

  it('with no category, lists every transaction of the week with its movements, and says so', async () => {
    const { user } = await seedWeek();
    const r = await executeTool(user.id, 'get_recent_activity', {}) as Activity;

    expect(r.covers).toEqual({
      filter: 'all transactions', period_days: 7, transactions: 2, movements: 4, listed_transactions: 2, truncated: false,
    });
    expect(r.transactions.map((t) => [t.hash, t.movements.length])).toEqual([[INFLOW, 1], [SWAP, 3]]);
    expect(r.transactions[0]).toMatchObject({ link: `[0x4586…5555](https://basescan.org/tx/${INFLOW})` });
    expect(r.transactions[0].movements[0]).toMatchObject({
      label: 'unknown', amount_display: '0.0014997 ETH', usd_display: '$4.06', kind: 'transfer',
    });
    expect(r.transactions[1].movements.find((m) => m.kind === 'fee')).toMatchObject({ label: 'gas', usd_display: '$0.0025' });
  });

  it('a named category is kept and the result says it is only that category', async () => {
    const { user } = await seedWeek();
    const r = await executeTool(user.id, 'get_recent_activity', { label: 'unknown' }) as Activity;
    expect(r.covers).toMatchObject({ filter: 'only unknown', transactions: 1, movements: 1 });
    expect(r.transactions.map((t) => t.hash)).toEqual([INFLOW]);
  });

  it('the period is applied with or without a category', async () => {
    const { user } = await seedWeek();
    const month = await executeTool(user.id, 'get_recent_activity', { period_days: 30 }) as Activity;
    expect(month.covers).toMatchObject({ period_days: 30, transactions: 3, movements: 5 });
    const revenueWeek = await executeTool(user.id, 'get_recent_activity', { label: 'revenue' }) as Activity;
    expect(revenueWeek).toMatchObject({ covers: { transactions: 0, movements: 0 }, transactions: [] });
  });

  it('a transfer not classified yet is listed, as unknown', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await insertEvent({ wallet, direction: 'in', amount: 7, usdValue: 7, at: '1 hour' });
    const all = await executeTool(user.id, 'get_recent_activity', {}) as Activity;
    expect(all.transactions[0].movements).toEqual([expect.objectContaining({ label: 'unknown' })]);
    const unknown = await executeTool(user.id, 'get_recent_activity', { label: 'unknown' }) as Activity;
    expect(unknown.covers.movements).toBe(1);
  });

  it('the limit counts transactions, never splits one, and says the list is cut short', async () => {
    const { user, wallet } = await seedWeek();
    await seedSwap(wallet, `0x${'aaaa'.padEnd(64, '1')}`, '5 hours');
    const r = await executeTool(user.id, 'get_recent_activity', { limit: 2 }) as Activity;
    expect(r.covers).toMatchObject({ transactions: 3, movements: 7, listed_transactions: 2, truncated: true });
    expect(r.transactions.map((t) => t.movements.length)).toEqual([1, 3]);
  });

  it("another operator's transactions never appear, and a made-up label falls back to all", async () => {
    await seedWeek();
    const bob = await seedUserWithWallet();
    const r = await executeTool(bob.user.id, 'get_recent_activity', { label: 'not_a_label' }) as Activity;
    expect(r.covers).toMatchObject({ filter: 'all transactions', transactions: 0, movements: 0 });
    expect(r.transactions).toEqual([]);
  });
});
