// Integration: beta onboarding (src/telegram/onboarding.ts) against real Postgres.
// See tests/integration/helpers/db.ts for how to run.
import { it, expect } from 'vitest';
import { describeDb, useIntegrationDb, sql } from './helpers/db.js';
import { resolveTelegramUser, inviteUsername, revokeUsername } from '../../src/telegram/onboarding.js';

async function userCount(telegramId: number): Promise<number> {
  const rows = await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE telegram_id = $1`, [telegramId]);
  return rows[0].n;
}

async function inviteFor(username: string) {
  const rows = await sql<{ telegram_id: string; status: string }>(
    `SELECT telegram_id::text, status FROM beta_invites WHERE LOWER(LTRIM(telegram_username, '@')) = $1`,
    [username],
  );
  return rows;
}

describeDb('beta onboarding (integration)', () => {
  useIntegrationDb();

  it('signs up an invited username on first message and pins the invite to their ID', async () => {
    expect(await inviteUsername('@HeisAnu', 'admin:1')).toBe('invited');

    const first = await resolveTelegramUser({ id: 111111, username: 'heisanu' });
    expect(first.status).toBe('ok');
    expect(first.status === 'ok' && first.created).toBe(true);
    expect(await inviteFor('heisanu')).toEqual([{ telegram_id: '111111', status: 'active' }]);

    const again = await resolveTelegramUser({ id: 111111, username: 'heisanu' });
    expect(again.status === 'ok' && again.created).toBe(false);
    expect(await userCount(111111)).toBe(1);
  });

  it('keeps access after a username change once the invite is claimed', async () => {
    await inviteUsername('oldhandle', 'admin:1');
    await resolveTelegramUser({ id: 222222, username: 'oldhandle' });
    const later = await resolveTelegramUser({ id: 222222, username: 'newhandle' });
    expect(later.status).toBe('ok');
  });

  it('matches hand-inserted placeholder invites stored with @ and mixed case', async () => {
    await sql(`INSERT INTO beta_invites (telegram_id, telegram_username, status) VALUES (-2, '@DannyMeta888', 'active')`);
    const res = await resolveTelegramUser({ id: 333333, username: 'dannymeta888' });
    expect(res.status).toBe('ok');
  });

  it('refuses people without an invite and creates no account', async () => {
    const res = await resolveTelegramUser({ id: 444444, username: 'stranger' });
    expect(res.status).toBe('not_invited');
    expect(await userCount(444444)).toBe(0);

    const noUsername = await resolveTelegramUser({ id: 444445 });
    expect(noUsername.status).toBe('not_invited');
  });

  it('does not let someone else take over an invite that was already claimed', async () => {
    await inviteUsername('alice_beta', 'admin:1');
    await resolveTelegramUser({ id: 555551, username: 'alice_beta' });

    const impostor = await resolveTelegramUser({ id: 555552, username: 'alice_beta' });
    expect(impostor.status).toBe('not_invited');
    expect(await userCount(555552)).toBe(0);
  });

  it('blocks a revoked tester immediately and restores them when re-invited', async () => {
    await inviteUsername('nfteague', 'admin:1');
    await resolveTelegramUser({ id: 666666, username: 'nfteague' });

    expect(await revokeUsername('@nfteague', 'admin:1')).toBe('revoked');
    expect((await resolveTelegramUser({ id: 666666, username: 'nfteague' })).status).toBe('revoked');

    expect(await inviteUsername('nfteague', 'admin:1')).toBe('reactivated');
    expect((await resolveTelegramUser({ id: 666666, username: 'nfteague' })).status).toBe('ok');
  });

  it('refuses a revoked invite that was never claimed, without creating an account', async () => {
    await inviteUsername('latecomer', 'admin:1');
    await revokeUsername('latecomer', 'admin:1');
    expect((await resolveTelegramUser({ id: 777777, username: 'latecomer' })).status).toBe('revoked');
    expect(await userCount(777777)).toBe(0);
  });

  it('keeps existing users without an invite row, and can still revoke them', async () => {
    await sql(`INSERT INTO users (telegram_id, telegram_username) VALUES (888888, 'earlyuser')`);
    expect((await resolveTelegramUser({ id: 888888, username: 'earlyuser' })).status).toBe('ok');

    expect(await revokeUsername('earlyuser', 'admin:1')).toBe('revoked');
    expect((await resolveTelegramUser({ id: 888888, username: 'earlyuser' })).status).toBe('revoked');
  });

  it('never locks out an admin', async () => {
    await sql(`INSERT INTO users (telegram_id, telegram_username, role) VALUES (999999, 'founder', 'admin')`);
    expect(await revokeUsername('founder', 'admin:1')).toBe('admin');
    await sql(`INSERT INTO beta_invites (telegram_id, telegram_username, status) VALUES (999999, 'founder', 'revoked')`);
    expect((await resolveTelegramUser({ id: 999999, username: 'founder' })).status).toBe('ok');
  });

  it('gives each username-only invite its own placeholder ID', async () => {
    expect(await inviteUsername('tester_one', 'admin:1')).toBe('invited');
    expect(await inviteUsername('tester_two', 'admin:1')).toBe('invited');
    const rows = await sql<{ telegram_id: string }>(`SELECT telegram_id::text FROM beta_invites ORDER BY beta_invites.telegram_id`);
    expect(rows.map((r) => r.telegram_id)).toEqual(['-2', '-1']);
  });

  it('creates exactly one account when a new tester sends two messages at once', async () => {
    await inviteUsername('fastfingers', 'admin:1');
    const [a, b] = await Promise.all([
      resolveTelegramUser({ id: 121212, username: 'fastfingers' }),
      resolveTelegramUser({ id: 121212, username: 'fastfingers' }),
    ]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(await userCount(121212)).toBe(1);
  });

  it('rejects malformed usernames', async () => {
    expect(await inviteUsername(undefined, 'admin:1')).toBe('invalid');
    expect(await inviteUsername('@ab', 'admin:1')).toBe('invalid');
    expect(await revokeUsername('bad name!', 'admin:1')).toBe('invalid');
  });
});
