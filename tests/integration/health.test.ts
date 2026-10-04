// Integration: health alerts (src/health/detectors.ts) against real Postgres.
// See tests/integration/helpers/db.ts for how to run.
import { it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, insertUser, insertWallet, insertWatchJob, sql,
} from './helpers/db.js';
import { detectStaleWallets, detectWorkerStale } from '../../src/health/detectors.js';
import { pingWorkerHeartbeat, touchWorkerHeartbeat } from '../../src/health/monitor.js';
import { deliverWorkerStaleAlerts, getUndeliveredAlerts } from '../../src/alerts/deliver.js';
import type { Telegram } from 'telegraf';

describeDb('health alerts (integration)', () => {
  useIntegrationDb();

  it("tells admins, not the operator, when an operator's wallet stopped syncing", async () => {
    const admin = await insertUser({ role: 'admin', username: 'danbuildss' });
    const user = await insertUser({ username: 'nfteague' });
    const wallet = await insertWallet({ userId: user.id });
    await insertWatchJob({ userId: user.id, walletId: wallet.id, lastSyncedAt: '21 hours' });

    expect(await detectStaleWallets(user.id)).toBe(1);
    expect(await sql(`SELECT 1 FROM alerts WHERE user_id = $1`, [user.id])).toEqual([]);
    const rows = await sql<{ type: string; message: string }>(`SELECT type, message FROM alerts WHERE user_id = $1`, [admin.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('wallet_stale');
    expect(rows[0].message).toContain("@nfteague's wallet");
  });

  it('ignores deactivated wallets, which are never synced on purpose', async () => {
    await insertUser({ role: 'admin' });
    const user = await insertUser({});
    const wallet = await insertWallet({ userId: user.id, active: false });
    await insertWatchJob({ userId: user.id, walletId: wallet.id, lastSyncedAt: '21 hours' });

    expect(await detectStaleWallets(user.id)).toBe(0);
  });

  it('a stopped worker is told to admins only, and sent by the bot (the worker cannot send it)', async () => {
    const admin = await insertUser({ role: 'admin' });
    const user = await insertUser({});
    await sql(`UPDATE worker_heartbeat SET last_ping_at = NOW() - INTERVAL '1 hour' WHERE id = 1`);
    expect(await detectWorkerStale()).toBe(1);
    expect(await detectWorkerStale()).toBe(0);
    expect(await sql(`SELECT 1 FROM alerts WHERE user_id = $1`, [user.id])).toEqual([]);
    expect(await sql<{ type: string }>(`SELECT type FROM alerts WHERE user_id = $1`, [admin.id])).toEqual([{ type: 'worker_stale' }]);

    // The worker's delivery leaves it to the bot
    expect(await getUndeliveredAlerts(admin.id)).toEqual([]);
    const sent: number[] = [];
    await deliverWorkerStaleAlerts({ sendMessage: (chat: number) => { sent.push(chat); return Promise.resolve({ message_id: 1 }); } } as unknown as Telegram);
    expect(sent).toEqual([admin.telegramId]);
    expect(await sql(`SELECT 1 FROM alerts WHERE user_id = $1 AND sent_at IS NULL`, [admin.id])).toEqual([]);
  });

  it('health alerts queued for an operator before this change are never delivered to them', async () => {
    const user = await insertUser({});
    for (const type of ['disk_pressure', 'wallet_stale', 'classifier_degradation']) {
      await sql(`INSERT INTO alerts (user_id, type, message, dedup_key) VALUES ($1, $2, 'Server disk is filling up', $3)`, [user.id, type, `${type}:old:${user.id}`]);
    }
    await sql(`INSERT INTO alerts (user_id, type, message, dedup_key) VALUES ($1, 'large_inflow', 'Large inflow', $2)`, [user.id, `large_inflow:x:${user.id}`]);
    const noon = new Date('2026-10-05T12:00:00Z');
    expect((await getUndeliveredAlerts(user.id, noon)).map((a) => a.type)).toEqual(['large_inflow']);
  });

  it('a slow cycle that is still working checks in mid-cycle: no alert, and the cycle count is unchanged (Sep 28)', async () => {
    await insertUser({ role: 'admin' });
    await pingWorkerHeartbeat();
    await sql(`UPDATE worker_heartbeat SET last_ping_at = NOW() - INTERVAL '9 minutes' WHERE id = 1`);
    const before = (await sql<{ loop_count: string }>(`SELECT loop_count::text FROM worker_heartbeat WHERE id = 1`))[0].loop_count;

    await touchWorkerHeartbeat();
    expect(await detectWorkerStale()).toBe(0);
    expect((await sql<{ loop_count: string }>(`SELECT loop_count::text FROM worker_heartbeat WHERE id = 1`))[0].loop_count).toBe(before);
  });
});
