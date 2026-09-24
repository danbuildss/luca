import { query } from '../db.js';
import { logger } from '../logger.js';

// Every answer is saved with the question and the exact read-tool calls behind it
// (periods, filters), so "where does that come from?" can be answered from the same set.

export type ToolUse = { name: string; args: Record<string, unknown> };

export async function saveAnswerTrace(params: {
  userId: string;
  question: string;
  answer: string;
  tools: ToolUse[];
}): Promise<void> {
  await query(
    `INSERT INTO answer_traces (user_id, question, answer, tools) VALUES ($1, $2, $3, $4)`,
    [params.userId, params.question, params.answer, JSON.stringify(params.tools)],
  ).catch((err: unknown) => logger.warn({ err, userId: params.userId }, 'Could not save answer trace'));
}

export type PreviousAnswer = { asked_at: Date; question: string; answer: string; tools: ToolUse[] };

export async function getPreviousAnswers(userId: string, limit = 3): Promise<PreviousAnswer[]> {
  const res = await query<PreviousAnswer>(
    `SELECT created_at AS asked_at, question, LEFT(answer, 400) AS answer, tools
     FROM answer_traces WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 10)],
  );
  return res.rows;
}
