import type pg from 'pg';
import { pool, query } from '../db.js';
import type { AuthedUser } from './auth.js';

export type AccessResult =
  | { status: 'ok'; user: AuthedUser; created: boolean }
  | { status: 'not_invited' }
  | { status: 'revoked' };

type InviteRow = { id: string; status: 'active' | 'revoked' };
type UserRow = { id: string; telegram_id: string; timezone: string; role: string };

// Telegram usernames: 5–32 chars of letters, digits and underscores.
export function normalizeUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = raw.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{5,32}$/.test(u) ? u : null;
}

// Invites created by username alone get a negative placeholder telegram_id until the
// person first messages the bot. Stored usernames may carry a leading '@' or mixed case.
const USERNAME_MATCH = `LOWER(LTRIM(telegram_username, '@'))`;

function toAuthedUser(row: UserRow): AuthedUser {
  return {
    userId: row.id,
    telegramId: Number(row.telegram_id),
    timezone: row.timezone,
    role: (row.role ?? 'operator') as 'operator' | 'admin',
  };
}

async function inviteByTelegramId(c: pg.PoolClient, telegramId: number): Promise<InviteRow | null> {
  const res = await c.query<InviteRow>(
    `SELECT id, status FROM beta_invites WHERE telegram_id = $1 FOR UPDATE`,
    [telegramId],
  );
  return res.rows[0] ?? null;
}

// Existing users keep access unless their invite is explicitly revoked (users created
// before invites existed have no invite row). Admins are never locked out. A new user
// needs an active invite, matched by Telegram ID or, for an unclaimed invite, by username;
// claiming pins the invite to their numeric ID so a later username change can't move it.
export async function resolveTelegramUser(from: {
  id: number;
  username?: string | null;
}): Promise<AccessResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let invite = await inviteByTelegramId(c, from.id);

    const existing = await c.query<UserRow>(
      `SELECT id, telegram_id, timezone, role FROM users WHERE telegram_id = $1`,
      [from.id],
    );
    if (existing.rows[0]) {
      await c.query('COMMIT');
      const user = toAuthedUser(existing.rows[0]);
      if (user.role !== 'admin' && invite?.status === 'revoked') return { status: 'revoked' };
      return { status: 'ok', user, created: false };
    }

    const username = normalizeUsername(from.username);
    if (!invite && username) {
      const claim = await c.query<InviteRow>(
        `SELECT id, status FROM beta_invites
         WHERE ${USERNAME_MATCH} = $1 AND telegram_id < 0
         ORDER BY invited_at ASC
         LIMIT 1
         FOR UPDATE`,
        [username],
      );
      const unclaimed = claim.rows[0];
      if (unclaimed?.status === 'active') {
        await c.query(`UPDATE beta_invites SET telegram_id = $2 WHERE id = $1`, [unclaimed.id, from.id]);
        invite = unclaimed;
      } else if (unclaimed) {
        invite = unclaimed;
      }
    }
    // A concurrent first message may have claimed the invite for this ID meanwhile
    invite ??= await inviteByTelegramId(c, from.id);

    if (!invite) {
      await c.query('COMMIT');
      return { status: 'not_invited' };
    }
    if (invite.status === 'revoked') {
      await c.query('COMMIT');
      return { status: 'revoked' };
    }

    const inserted = await c.query(
      `INSERT INTO users (telegram_id, telegram_username) VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO NOTHING`,
      [from.id, username],
    );
    const created = await c.query<UserRow>(
      `SELECT id, telegram_id, timezone, role FROM users WHERE telegram_id = $1`,
      [from.id],
    );
    await c.query('COMMIT');
    return { status: 'ok', user: toAuthedUser(created.rows[0]), created: (inserted.rowCount ?? 0) > 0 };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export type InviteOutcome = 'invited' | 'reactivated' | 'invalid';

export async function inviteUsername(raw: string | undefined, invitedBy: string): Promise<InviteOutcome> {
  const username = normalizeUsername(raw);
  if (!username) return 'invalid';

  const reactivated = await query(
    `UPDATE beta_invites SET status = 'active' WHERE ${USERNAME_MATCH} = $1`,
    [username],
  );
  if ((reactivated.rowCount ?? 0) > 0) return 'reactivated';

  await query(
    `INSERT INTO beta_invites (telegram_id, telegram_username, invited_by, status)
     SELECT LEAST(COALESCE(MIN(telegram_id), 0), 0) - 1, $1, $2, 'active' FROM beta_invites`,
    [username, invitedBy],
  );
  return 'invited';
}

export type RevokeOutcome = 'revoked' | 'not_found' | 'admin' | 'invalid';

export async function revokeUsername(raw: string | undefined, revokedBy: string): Promise<RevokeOutcome> {
  const username = normalizeUsername(raw);
  if (!username) return 'invalid';

  const user = await query<{ telegram_id: string; role: string }>(
    `SELECT telegram_id, role FROM users WHERE ${USERNAME_MATCH} = $1`,
    [username],
  );
  if (user.rows[0]?.role === 'admin') return 'admin';

  const byInvite = await query(
    `UPDATE beta_invites SET status = 'revoked' WHERE ${USERNAME_MATCH} = $1`,
    [username],
  );
  if (user.rows[0]) {
    // Covers users whose invite was stored under another username, or who have none
    await query(
      `INSERT INTO beta_invites (telegram_id, telegram_username, invited_by, status)
       VALUES ($1, $2, $3, 'revoked')
       ON CONFLICT (telegram_id) DO UPDATE SET status = 'revoked'`,
      [user.rows[0].telegram_id, username, revokedBy],
    );
    return 'revoked';
  }
  return (byInvite.rowCount ?? 0) > 0 ? 'revoked' : 'not_found';
}
