import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { getAiCost, getInviteStats, getUserStats, getWalletHealth } from '../ops/metrics.js';
import { traceTransaction } from '../ledger/trace.js';
import { config } from '../config.js';

// Founder questions ("how many invites are pending?", "who has not activated?",
// "which wallets are stale?", "what did AI cost this week?") answered from the same
// definitions /ops uses. Offered to the model only in an admin's chat, and every call
// re-checks the caller's role in the database, so an operator can never reach them.
// Most return counts, handles and sync state only. admin_trace_transaction is the one
// exception: to diagnose a missing transaction it shows how that single transaction was
// recorded (wallet, label, amount) for the wallets it touches. Never balances or books.

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
  {
    type: 'function',
    function: {
      name: 'admin_trace_transaction',
      description:
        'Admin only. Follow one Base transaction through every layer Luca keeps (chain, transfer feed, raw record, normalized event, asset identity, classification, price, books) for every Luca wallet it touches, and name the layer where a movement was lost. Use when asked whether Luca saw a transaction or why it is missing.',
      parameters: {
        type: 'object',
        properties: { hash: { type: 'string', description: 'The full transaction hash (0x followed by 64 hex characters).' } },
        required: ['hash'],
      },
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

export async function executeAdminTool(
  userId: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
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
    case 'admin_trace_transaction': {
      const hash = typeof args.hash === 'string' ? args.hash.trim() : '';
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return { error: 'Give the full transaction hash: 0x followed by 64 hex characters.' };
      return await traceTransaction(hash, config.ALCHEMY_API_KEY);
    }
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
