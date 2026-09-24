// Integration: src/alerts/detectors.ts against real Postgres.
// See tests/integration/helpers/db.ts for how to run.
import { describe, it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassifiedEvent,
  insertAlert, sql, type WalletFx,
} from './helpers/db.js';
import { detectLargeMovements, detectSpendSpike } from '../../src/alerts/detectors.js';

async function alertsOf(userId: string, type: string) {
  return sql<{ dedup_key: string; evidence: Record<string, unknown> }>(
    'SELECT dedup_key, evidence FROM alerts WHERE user_id = $1 AND type = $2 ORDER BY created_at',
    [userId, type],
  );
}

// Spend-spike fixture: $10/day of expenses in each of the 6 days before the last
// 24h (baseline daily avg = $10) plus one old event so the 7-day history is covered.
async function seedBaseline(wallet: WalletFx): Promise<void> {
  await insertEvent({ wallet, direction: 'in', amount: 1, usdValue: 1, at: '8 days' }); // history marker
  for (const hours of [36, 60, 84, 108, 132, 156]) {
    await insertClassifiedEvent({
      wallet, direction: 'out', label: 'expense', amount: 10, usdValue: 10, at: `${hours} hours`,
    });
  }
}

describeDb('alert detectors (integration)', () => {
  useIntegrationDb();

  describe('detectLargeMovements', () => {
    it('alerts on material movements in the last 24h only, once per event', async () => {
      const { user, wallet } = await seedUserWithWallet({ materialityUsd: 50 });
      const recentIn = await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', amount: 100, usdValue: 100, at: '1 hour' });
      const recentOut = await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', amount: 75, usdValue: null, at: '2 hours' }); // USDC 1:1
      await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', amount: 5000, usdValue: 5000, at: '30 hours' }); // too old
      await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', amount: 10, usdValue: 10, at: '1 hour' });       // immaterial
      await insertClassifiedEvent({ wallet, direction: 'out', label: 'internal_transfer', amount: 900, usdValue: 900 });       // excluded label

      expect(await detectLargeMovements(user.id)).toBe(2);

      const keys = (await sql<{ dedup_key: string }>(
        'SELECT dedup_key FROM alerts WHERE user_id = $1 ORDER BY dedup_key', [user.id],
      )).map((r) => r.dedup_key).sort();
      expect(keys).toEqual([`large_inflow:${recentIn.id}`, `large_outflow:${recentOut.id}`].sort());

      // Idempotent
      expect(await detectLargeMovements(user.id)).toBe(0);
    });

    it('does not alert on historic events after materiality is lowered', async () => {
      const { user, wallet } = await seedUserWithWallet({ materialityUsd: 10_000 });
      await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', amount: 500, usdValue: 500, at: '3 days' });
      await sql('UPDATE users SET materiality_usd = 1 WHERE id = $1', [user.id]);
      expect(await detectLargeMovements(user.id)).toBe(0);
    });
  });

  describe('detectSpendSpike', () => {
    it('fires at exactly 2× the prior-6-day daily average (baseline excludes the last 24h)', async () => {
      const { user, wallet } = await seedUserWithWallet({ materialityUsd: 1 });
      await seedBaseline(wallet);
      await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', amount: 20, usdValue: 20, at: '1 hour' });

      // If the last 24h leaked into the baseline, avg would be 80/6 ≈ 13.3 and 20 would be only 1.5×.
      expect(await detectSpendSpike(user.id)).toBe(1);
      const [alert] = await alertsOf(user.id, 'spend_spike');
      expect(alert.evidence).toMatchObject({ spend_24h: 20, daily_avg: 10, spike_ratio: 2, baseline_days: 6 });
    });

    it('does not fire just below 2×', async () => {
      const { user, wallet } = await seedUserWithWallet({ materialityUsd: 1 });
      await seedBaseline(wallet);
      await insertClassifiedEvent({ wallet, direction: 'out', label: 'x402_spend', amount: 19.99, usdValue: 19.99, at: '1 hour' });

      expect(await detectSpendSpike(user.id)).toBe(0);
      expect(await alertsOf(user.id, 'spend_spike')).toHaveLength(0);
    });

    it('does not fire when spend is below materiality even at a high ratio', async () => {
      const { user, wallet } = await seedUserWithWallet({ materialityUsd: 1000 });
      await seedBaseline(wallet);
      await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', amount: 100, usdValue: 100, at: '1 hour' });
      expect(await detectSpendSpike(user.id)).toBe(0);
    });

    it('does not fire without 7 days of history', async () => {
      const { user, wallet } = await seedUserWithWallet({ materialityUsd: 1 });
      await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', amount: 500, usdValue: 500, at: '1 hour' });
      expect(await detectSpendSpike(user.id)).toBe(0);
    });

    it('cooldown: no second spike alert within 24h, but one older than 24h does not block', async () => {
      const { user, wallet } = await seedUserWithWallet({ materialityUsd: 1 });
      await seedBaseline(wallet);
      await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', amount: 100, usdValue: 100, at: '1 hour' });

      // An alert from 25h ago is outside the cooldown
      await insertAlert({ userId: user.id, type: 'spend_spike', createdAt: '25 hours', dedupKey: 'spend_spike:old' });
      expect(await detectSpendSpike(user.id)).toBe(1);

      // Re-running (a new dedup key each call) is blocked by the 24h cooldown
      expect(await detectSpendSpike(user.id)).toBe(0);
      expect(await alertsOf(user.id, 'spend_spike')).toHaveLength(2);
    });

    it('cooldown: an alert from 23h ago blocks a new spike', async () => {
      const { user, wallet } = await seedUserWithWallet({ materialityUsd: 1 });
      await seedBaseline(wallet);
      await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', amount: 100, usdValue: 100, at: '1 hour' });
      await insertAlert({ userId: user.id, type: 'spend_spike', createdAt: '23 hours' });

      expect(await detectSpendSpike(user.id)).toBe(0);
    });

    it('cooldown is per user', async () => {
      const a = await seedUserWithWallet({ materialityUsd: 1 });
      const b = await seedUserWithWallet({ materialityUsd: 1 });
      for (const { wallet } of [a, b]) {
        await seedBaseline(wallet);
        await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', amount: 100, usdValue: 100, at: '1 hour' });
      }
      expect(await detectSpendSpike(a.user.id)).toBe(1);
      expect(await detectSpendSpike(b.user.id)).toBe(1);
    });
  });
});
