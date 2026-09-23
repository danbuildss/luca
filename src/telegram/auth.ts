import { query } from '../db.js';

export type AuthedUser = {
  userId: string;
  telegramId: number;
  timezone: string;
  role: 'operator' | 'admin';
};

export async function getUserByTelegramId(telegramId: number): Promise<AuthedUser | null> {
  const res = await query<{ id: string; telegram_id: string; timezone: string; role: string }>(
    `SELECT id, telegram_id, timezone, role FROM users WHERE telegram_id = $1`,
    [telegramId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    userId: row.id,
    telegramId: Number(row.telegram_id),
    timezone: row.timezone,
    role: (row.role ?? 'operator') as 'operator' | 'admin',
  };
}
