// Integration: health alerts (src/health/detectors.ts) against real Postgres.
// See tests/integration/helpers/db.ts for how to run.
import { it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, insertUser, insertWallet, insertWatchJob, sql,
} from './helpers/db.js';
import { detectStaleWallets, detectWorkerStale } from '../../src/health/detectors.js';

describeDb('health alerts (integration)', () => {
  useIntegrationDb();

  it('stores a wallet_stale alert for an active wallet that stopped syncing', async () => {
    const user = await insertUser({});
    const wallet = await insertWallet({ userId: user.id });
    await insertWatchJob({ userId: user.id, walletId: wallet.id, lastSyncedAt: '21 hours' });

    expect(await detectStaleWallets(user.id)).toBe(1);
    const rows = await sql<{ type: string }>(`SELECT type FROM alerts WHERE user_id = $1`, [user.id]);
    expect(rows).toEqual([{ type: 'wallet_stale' }]);
  });

  it('ignores deactivated wallets, which are never synced on purpose', async () => {
    const user = await insertUser({});
    const wallet = await insertWallet({ userId: user.id, active: false });
    await insertWatchJob({ userId: user.id, walletId: wallet.id, lastSyncedAt: '21 hours' });

    expect(await detectStaleWallets(user.id)).toBe(0);
  });

  it('stores a worker_stale alert when the worker has not pinged', async () => {
    const user = await insertUser({});
    await sql(`UPDATE worker_heartbeat SET last_ping_at = NOW() - INTERVAL '1 hour' WHERE id = 1`);
    expect(await detectWorkerStale(user.id)).toBe(1);
    const rows = await sql<{ type: string }>(`SELECT type FROM alerts WHERE user_id = $1`, [user.id]);
    expect(rows).toEqual([{ type: 'worker_stale' }]);
  });
});
