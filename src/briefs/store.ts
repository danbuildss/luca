import { query } from '../db.js';

export type BriefType = 'daily' | 'weekly';

export type BriefRow = {
  id: string;
  content: string;
  period_start: Date | null;
  period_end: Date | null;
  sent_at: Date | null;
  telegram_message_id: number | null;
  created_at: Date;
};

export async function saveBrief(params: {
  userId: string;
  type: BriefType;
  content: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO briefs (user_id, type, content, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.userId, params.type, params.content, params.periodStart, params.periodEnd],
  );
  return res.rows[0].id;
}

export async function markBriefSent(briefId: string, telegramMessageId: number): Promise<void> {
  await query(
    `UPDATE briefs SET sent_at = NOW(), telegram_message_id = $1 WHERE id = $2`,
    [telegramMessageId, briefId],
  );
}

export async function getLastBrief(userId: string, type: BriefType): Promise<BriefRow | null> {
  const res = await query<BriefRow>(
    `SELECT id, content, period_start, period_end, sent_at, telegram_message_id, created_at
     FROM briefs
     WHERE user_id = $1 AND type = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, type],
  );
  return res.rows[0] ?? null;
}

export type BriefUser = {
  userId: string;
  telegramId: number;
  timezone: string;
  briefTime: string; // HH:MM
};

export async function getAllBriefUsers(): Promise<BriefUser[]> {
  const res = await query<{
    id: string;
    telegram_id: string;
    timezone: string;
    brief_time: string;
  }>(
    `SELECT u.id, u.telegram_id::text, u.timezone, u.brief_time
     FROM users u
     WHERE EXISTS (
       SELECT 1 FROM watch_jobs wj WHERE wj.user_id = u.id AND wj.status = 'active'
     )`,
  );
  return res.rows.map((r) => ({
    userId: r.id,
    telegramId: Number(r.telegram_id),
    timezone: r.timezone,
    briefTime: r.brief_time,
  }));
}
