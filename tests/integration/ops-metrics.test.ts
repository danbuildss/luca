// Integration: founder metrics (src/ops/metrics.ts) add up, and /ops, the ops errors list
// and the admin chat tools all report the same numbers. See tests/integration/helpers/db.ts.
import { it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, insertUser, insertWallet, insertWatchJob, sql,
} from './helpers/db.js';
import { getInviteStats, getWalletHealth } from '../../src/ops/metrics.js';
import { getOpsErrors, getOpsOverview } from '../../src/ops/db.js';
import { executeAdminTool } from '../../src/agent/admin-tools.js';

async function invite(telegramId: number, username: string, status: 'active' | 'revoked' = 'active'): Promise<void> {
  await sql('INSERT INTO beta_invites (telegram_id, telegram_username, status) VALUES ($1, $2, $3)', [telegramId, username, status]);
}

// One of everything: an admin without an invite, invites in every state, and wallets
// that are ok, stale, never synced, failing, and deactivated (with a failing job).
async function seed() {
  const admin = await insertUser({ role: 'admin', username: 'founder' });

  await invite(-1001, 'pending_person');
  const joined = await insertUser({ username: 'joined_person' });
  await invite(joined.telegramId, 'joined_person');
  const activated = await insertUser({ username: 'activated_person' });
  await sql('UPDATE users SET activated_at = NOW() WHERE id = $1', [activated.id]);
  await invite(activated.telegramId, 'activated_person');
  await invite(424242, 'revoked_person', 'revoked');

  const ok = await insertWallet({ userId: activated.id });
  await insertWatchJob({ userId: activated.id, walletId: ok.id, lastSyncedAt: '5 minutes' });
  const stale = await insertWallet({ userId: activated.id });
  await insertWatchJob({ userId: activated.id, walletId: stale.id, lastSyncedAt: '5 hours' });
  const never = await insertWallet({ userId: joined.id });
  await insertWatchJob({ userId: joined.id, walletId: never.id, lastSyncedAt: null });
  const failing = await insertWallet({ userId: joined.id });
  await insertWatchJob({ userId: joined.id, walletId: failing.id, status: 'error', errorMessage: 'rpc down', lastSyncedAt: '1 hour' });
  const gone = await insertWallet({ userId: activated.id, active: false });
  await insertWatchJob({ userId: activated.id, walletId: gone.id, status: 'error', errorMessage: 'old', lastSyncedAt: '30 days' });
  const goneStale = await insertWallet({ userId: activated.id, active: false });
  await insertWatchJob({ userId: activated.id, walletId: goneStale.id, lastSyncedAt: '30 days' });

  return { admin, joined, activated };
}

describeDb('ops metrics (integration)', () => {
  useIntegrationDb();

  it('wallet counts add up and never count a deactivated wallet as stale or failing', async () => {
    await seed();
    const w = await getWalletHealth();
    expect(w).toMatchObject({ monitored: 4, ok: 1, stale: 2, error: 1, inactive: 2 });
    expect(w.ok + w.stale + w.error).toBe(w.monitored);
    expect(w.problems).toHaveLength(3);
  });

  it('invite counts add up', async () => {
    await seed();
    const i = await getInviteStats();
    expect(i).toMatchObject({ invited: 4, pending: 1, joined: 1, activated: 1, revoked: 1 });
    expect(i.pending + i.joined + i.activated + i.revoked).toBe(i.invited);
    expect(i.not_activated.map((n) => [n.username, n.state])).toEqual([
      ['pending_person', 'pending'], ['joined_person', 'joined'],
    ]);
  });

  it('/ops, the errors list and the admin tools agree', async () => {
    const { admin, joined } = await seed();
    const [ov, errors, health, invites] = await Promise.all([
      getOpsOverview(), getOpsErrors(), getWalletHealth(), getInviteStats(),
    ]);
    expect(ov.wallets).toMatchObject({ monitored: health.monitored, ok: health.ok, stale: health.stale, error: health.error });
    expect(ov.stale_wallets).toBe(health.stale);
    expect(ov.stale_wallets).toBeLessThanOrEqual(ov.total_wallets);
    expect(errors.stale_wallets).toHaveLength(health.stale);
    expect(errors.sync_errors).toHaveLength(health.error);
    expect(ov.invites).toEqual(invites);

    expect(await executeAdminTool(admin.id, 'admin_get_invite_stats')).toEqual(invites);
    expect(await executeAdminTool(admin.id, 'admin_get_wallet_health')).toEqual(health);
    expect(await executeAdminTool(joined.id, 'admin_get_invite_stats')).toEqual({ error: 'Not available.' });
  });
});
