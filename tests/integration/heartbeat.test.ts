// Integration: portfolio alerts compare only snapshots that cover the same wallets and
// assets with complete data (src/heartbeat). See tests/integration/helpers/db.ts.
import { describe, it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertWallet, insertWatchJob, sql,
} from './helpers/db.js';
import { detectPortfolioChanges } from '../../src/heartbeat/detector.js';
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

  describe('portfolio alerts', () => {
    it('the Sep 25 case: $20,309 to $2.48 against a snapshot from before coverage tracking fires nothing', async () => {
      const { user, wallet } = await seedUserWithWallet();
      // Written before migration 020: complete defaults to FALSE, no wallet list, no reason
      await insertSnapshot({ userId: user.id, daysAgo: 1, total: 20309.187505, complete: false, walletIds: null, assets: null });
      await insertSnapshot({ userId: user.id, daysAgo: 0, total: 2.479372088551099, walletIds: [wallet.id] });

      expect(await detectPortfolioChanges(user.id)).toBe(0);
      expect(await alerts(user.id)).toEqual([]);
    });

    it('does not compare when the wallet set changed between the two days', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const other = await insertWallet({ userId: user.id });
      await insertSnapshot({ userId: user.id, daysAgo: 1, total: 20000, walletIds: [wallet.id, other.id] });
      await insertSnapshot({ userId: user.id, daysAgo: 0, total: 2.48, walletIds: [wallet.id] });

      expect(await detectPortfolioChanges(user.id)).toBe(0);
      expect(await alerts(user.id)).toEqual([]);
    });

    it('does not compare when the asset set changed', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertSnapshot({ userId: user.id, daysAgo: 1, total: 5000, walletIds: [wallet.id], assets: ['ETH', 'USDC'] });
      await insertSnapshot({ userId: user.id, daysAgo: 0, total: 1000, walletIds: [wallet.id] });
      expect(await detectPortfolioChanges(user.id)).toBe(0);
    });

    it('does not compare snapshots that are not on consecutive days', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertSnapshot({ userId: user.id, daysAgo: 3, total: 5000, walletIds: [wallet.id] });
      await insertSnapshot({ userId: user.id, daysAgo: 0, total: 1000, walletIds: [wallet.id] });
      expect(await detectPortfolioChanges(user.id)).toBe(0);
    });

    it('alerts on a real drop when both days are complete and cover the same wallets and assets', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertSnapshot({ userId: user.id, daysAgo: 1, total: 5000, walletIds: [wallet.id] });
      await insertSnapshot({ userId: user.id, daysAgo: 0, total: 3000, walletIds: [wallet.id] });

      expect(await detectPortfolioChanges(user.id)).toBe(1);
      const [alert] = await alerts(user.id);
      expect(alert.type).toBe('portfolio_down');
      expect(alert.certainty).toBe('verified');
      expect(alert.message).toContain('down $2000.00 (-40.0%)');
    });

    it('an incomplete day (missing price or stale balances) fires no portfolio alert', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertSnapshot({ userId: user.id, daysAgo: 1, total: 5000, walletIds: [wallet.id] });
      await insertSnapshot({
        userId: user.id, daysAgo: 0, total: 2.48, walletIds: [wallet.id], complete: false,
        reason: 'a live price is unavailable', createdHoursAgo: 1,
      });

      expect(await detectPortfolioChanges(user.id)).toBe(0);
      expect(await alerts(user.id)).toEqual([]);
    });

    it('tells the operator once, as a data issue, when a day stays incomplete for 6 hours', async () => {
      const { user, wallet } = await seedUserWithWallet();
      await insertSnapshot({
        userId: user.id, daysAgo: 0, total: 2.48, walletIds: [wallet.id], complete: false,
        reason: 'ETH balance is out of date', createdHoursAgo: 7,
      });

      expect(await detectPortfolioChanges(user.id)).toBe(1);
      expect(await detectPortfolioChanges(user.id)).toBe(0);
      const [alert] = await alerts(user.id);
      expect(alert.type).toBe('snapshot_incomplete');
      expect(alert.certainty).toBe('data_issue');
      expect(alert.message).toContain('ETH balance is out of date');
      expect(alert.message).not.toMatch(/\$/);
    });

    it('sends no incomplete notice for a row written before coverage tracking', async () => {
      const { user } = await seedUserWithWallet();
      await insertSnapshot({ userId: user.id, daysAgo: 0, total: 2.48, complete: false, walletIds: null, reason: null, createdHoursAgo: 12 });
      expect(await detectPortfolioChanges(user.id)).toBe(0);
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
