import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { getAiCost, getInviteStats, getUserStats, getWalletHealth } from '../ops/metrics.js';

// Founder questions ("how many invites are pending?", "who has not activated?",
// "which wallets are stale?", "what did AI cost this week?") answered from the same
// definitions /ops uses. Offered to the model only in an admin's chat, and every call
// re-checks the caller's role in the database, so an operator can never reach them.
// They return counts, handles and sync state only: never another user's balances,
// transactions or books.

export const ADMIN_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'admin_get_invite_stats',
      description:
        'Admin only. Beta invites: invited, pending (not opened the bot), joined (no wallet synced yet), activated, revoked, and who has not activated yet. Same numbers as /ops.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_get_user_stats',
      description:
        'Admin only. Users with an account: total, admins, activated, active in the last 24 hours and 7 days. Same numbers as /ops.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_get_wallet_health',
      description:
        'Admin only. Monitored wallets by sync state (ok, stale, error), deactivated wallets, and which wallets are stale or failing. Same numbers as /ops.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_get_ai_cost',
      description:
        'Admin only. AI spend recorded by Luca today, over the last 7 and 30 days, and by purpose for the last 7 days.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const ADMIN_TOOL_NAMES = new Set(
  ADMIN_TOOL_DEFINITIONS.map((t) => (t.type === 'function' ? t.function.name : '')),
);

export function isAdminTool(name: string): boolean {
  return ADMIN_TOOL_NAMES.has(name);
}

async function isAdmin(userId: string): Promise<boolean> {
  const res = await query<{ role: string }>(`SELECT role::text AS role FROM users WHERE id = $1`, [userId]);
  return res.rows[0]?.role === 'admin';
}

export async function executeAdminTool(userId: string, toolName: string): Promise<Record<string, unknown>> {
  if (!(await isAdmin(userId))) {
    logger.warn({ userId, toolName }, 'Admin tool refused for a non-admin');
    return { error: 'Not available.' };
  }
  switch (toolName) {
    case 'admin_get_invite_stats':
      return await getInviteStats();
    case 'admin_get_user_stats':
      return await getUserStats();
    case 'admin_get_wallet_health':
      return await getWalletHealth();
    case 'admin_get_ai_cost':
      return await getAiCost();
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
