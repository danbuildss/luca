// Integration: daily snapshots and what they may alert about (src/heartbeat).
// See tests/integration/helpers/db.ts.
import { describe, it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertWallet, insertWatchJob, sql,
} from './helpers/db.js';
import { detectBooksAttention } from '../../src/heartbeat/detector.js';
import { snapshotCoverage, SNAPSHOT_ASSETS } from '../../src/heartbeat/snapshot.js';

const ASSETS = [...SNAPSHOT_ASSETS];

async function insertSnapshot(opts: {
  userId: string;
  daysAgo: number;
  total: number;
  complete?: boolean;
  walletIds?: string[] | null;
  assets?: string[] | null;
  reason?: string | null;
  createdHoursAgo?: number;
}): Promise<void> {
  await sql(
    `INSERT INTO financial_heartbeat_snapshots
       (user_id, snapshot_date, total_balance_usdc, complete, wallet_ids, assets, incomplete_reason, created_at)
     VALUES ($1, CURRENT_DATE - $2::int, $3, $4, $5, $6, $7, NOW() - ($8::int * INTERVAL '1 hour'))`,
    [
      opts.userId, opts.daysAgo, opts.total, opts.complete ?? true,
      opts.walletIds === undefined ? null : opts.walletIds,
      opts.assets === undefined ? ASSETS : opts.assets,
      opts.reason ?? null, opts.createdHoursAgo ?? 0,
    ],
  );
}

async function alerts(userId: string) {
  return sql<{ type: string; certainty: string | null; message: string }>(
    'SELECT type, certainty, message FROM alerts WHERE user_id = $1 ORDER BY type', [userId],
  );
}

async function balance(userId: string, walletId: string, asset: string, age = '5 minutes'): Promise<void> {
  await sql(
    `INSERT INTO balance_snapshots (wallet_id, user_id, asset, balance, snapshot_at)
     VALUES ($1, $2, $3, 1, NOW() - $4::interval)`,
    [walletId, userId, asset, age],
  );
}

describeDb('heartbeat (integration)', () => {
  useIntegrationDb();

  describe('overnight alerts', () => {
    it('the Oct 4 case: holdings "down 73.7%" after a stake sends nothing', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertSnapshot({ userId: user.id, daysAgo: 1, total: 852.43, walletIds: [wallet.id] });
      await insertSnapshot({ userId: user.id, daysAgo: 0, total: 224.19, walletIds: [wallet.id] });

      expect(await detectBooksAttention(user.id)).toBe(0);
      expect(await alerts(user.id)).toEqual([]);
    });

    it('a rise sends nothing, and there is no "positive week" alert (the Monday brief says it)', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertSnapshot({ userId: user.id, daysAgo: 1, total: 1000, walletIds: [wallet.id] });
      await insertSnapshot({ userId: user.id, daysAgo: 0, total: 5000, walletIds: [wallet.id] });
      await sql(`UPDATE financial_heartbeat_snapshots SET net_pnl_7d = 1176.38, revenue_7d = 1180 WHERE user_id = $1`, [user.id]);

      expect(await detectBooksAttention(user.id)).toBe(0);
      expect(await alerts(user.id)).toEqual([]);
    });

    it('a day that stays incomplete sends the operator nothing', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertSnapshot({
        userId: user.id, daysAgo: 0, total: 2.48, walletIds: [wallet.id], complete: false,
        reason: 'ETH balance is out of date', createdHoursAgo: 7,
      });
      expect(await detectBooksAttention(user.id)).toBe(0);
      expect(await alerts(user.id)).toEqual([]);
    });

    it('still says once a day when more than 10 transfers this week need context', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertSnapshot({ userId: user.id, daysAgo: 0, total: 100, walletIds: [wallet.id] });
      await sql(`UPDATE financial_heartbeat_snapshots SET unknown_count_7d = 12 WHERE user_id = $1`, [user.id]);

      expect(await detectBooksAttention(user.id)).toBe(1);
      expect(await detectBooksAttention(user.id)).toBe(0);
      const [alert] = await alerts(user.id);
      expect(alert.type).toBe('books_attention');
      expect(alert.message).toContain('12 transfers this week still need context');
    });
  });

  describe('snapshot coverage', () => {
    it('is complete when every active wallet has a fresh balance for every asset and prices are available', async () => {
      const { user, wallet } = await seedUserWithWallet();
      for (const asset of ASSETS) await balance(user.id, wallet.id, asset);
      // A deactivated wallet is neither required nor listed
      const old = await insertWallet({ userId: user.id, active: false });
      await insertWatchJob({ userId: user.id, walletId: old.id, status: 'error' });

      const c = await snapshotCoverage(user.id, false);
      expect(c.complete).toBe(true);
      expect(c.wallet_ids).toEqual([wallet.id]);
      expect(c.assets).toEqual(ASSETS);
      expect(c.reasons).toEqual([]);
    });

    it('is incomplete when a price is unavailable', async () => {
      const { user, wallet } = await seedUserWithWallet();
      for (const asset of ASSETS) await balance(user.id, wallet.id, asset);
      const c = await snapshotCoverage(user.id, true);
      expect(c.complete).toBe(false);
      expect(c.reasons).toContain('a live price is unavailable');
    });

    it('is incomplete when a balance is out of date or missing', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await balance(user.id, wallet.id, 'ETH', '3 hours');
      await balance(user.id, wallet.id, 'USDC');
      const c = await snapshotCoverage(user.id, false);
      expect(c.complete).toBe(false);
      expect(c.reasons).toContain(`ETH balance for ${wallet.address} is out of date`);
      expect(c.reasons).toContain(`no BNKR balance for ${wallet.address}`);
      expect(c.reasons).toHaveLength(2);
    });

    it('is incomplete when the last sync of a wallet failed', async () => {
      const { user } = await seedUserWithWallet();
      const bad = await insertWallet({ userId: user.id });
      await insertWatchJob({ userId: user.id, walletId: bad.id, status: 'error' });
      const c = await snapshotCoverage(user.id, false);
      expect(c.complete).toBe(false);
      expect(c.reasons).toContain(`last sync of ${bad.address} failed`);
    });
  });
});
