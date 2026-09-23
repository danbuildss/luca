import { query } from '../db.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';

const HISTORY_LIMIT = 20;

export async function loadConversationHistory(userId: string): Promise<ChatCompletionMessageParam[]> {
  const res = await query<{ role: string; content: string }>(
    `SELECT role, content
     FROM conversation_messages
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, HISTORY_LIMIT],
  );
  // Reverse so oldest is first (chronological order for the model)
  return res.rows.reverse().map((r) => ({
    role: r.role as 'user' | 'assistant',
    content: r.content,
  }));
}

export async function saveMessage(params: {
  userId: string;
  role: 'user' | 'assistant';
  content: string;
}): Promise<void> {
  await query(
    `INSERT INTO conversation_messages (user_id, role, content)
     VALUES ($1, $2, $3)`,
    [params.userId, params.role, params.content],
  );
}

export async function clearConversation(userId: string): Promise<void> {
  await query(
    `DELETE FROM conversation_messages WHERE user_id = $1`,
    [userId],
  );
}
