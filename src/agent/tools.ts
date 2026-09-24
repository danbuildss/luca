import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { query } from '../db.js';
import { getPnlSummary, getBooksSummary, getBooksEvents } from '../books/query.js';
import { getValuedBalances } from '../books/balances.js';
import { getEventsForReview, getEventWithClassification } from '../corrections/store.js';
import { applyCorrection } from '../corrections/handler.js';
import { ClassificationLabel, CLASSIFICATION_LABELS, WALLET_ROLES, SUPPORTED_CHAINS } from '../types/index.js';

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function calling schema)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_cash_position',
      description: 'Get the current ETH, USDC and BNKR balances across all registered wallets, each valued in USD at live prices, plus the total. Use this to answer "how much do we have?" or "what is our cash position?"',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_books_summary',
      description: 'Get a P&L summary (revenue, expenses, gas, net) over a given period. Use this for financial overviews, trend questions, or runway analysis.',
      parameters: {
        type: 'object',
        properties: {
          period_days: {
            type: 'number',
            description: 'Number of days to look back. Default 30.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_activity',
      description: 'Get recent transactions with their classification labels. Use this to show what happened recently, investigate a specific label category, or answer questions about specific movements.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of transactions to return. Default 20, max 50.',
          },
          label: {
            type: 'string',
            enum: [...CLASSIFICATION_LABELS],
            description: 'Filter by classification label. Omit to show all.',
          },
          period_days: {
            type: 'number',
            description: 'Number of days to look back. Default 7.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_wallets',
      description: "Get all registered wallets for this operator, including their labels, chains, and assigned roles (operations, treasury, agent, etc.).",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_wallet_balance',
      description: 'Get the most recent balance snapshot for a specific wallet address.',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'The wallet address to query.',
          },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_unknown_transactions',
      description: "Get transactions that haven't been classified yet or are labeled 'unknown'. Use this when the operator asks what needs attention or what is unclassified.",
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of transactions to return. Default 20.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transaction',
      description: 'Get full details for a specific transaction by its event ID. Use this to investigate a specific movement.',
      parameters: {
        type: 'object',
        properties: {
          event_id: {
            type: 'string',
            description: 'The event UUID to look up.',
          },
        },
        required: ['event_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_correction',
      description: "Reclassify a transaction and optionally name the counterparty. Use this when the operator corrects a label (e.g. 'that wasn't revenue, it was an internal transfer'). This is a write operation — only call it when the operator explicitly asks to change a classification.",
      parameters: {
        type: 'object',
        properties: {
          event_id: {
            type: 'string',
            description: 'The event UUID to reclassify.',
          },
          new_label: {
            type: 'string',
            enum: [...CLASSIFICATION_LABELS],
            description: 'The correct classification label.',
          },
          reason: {
            type: 'string',
            description: 'Brief reason for the correction, e.g. "ops wallet", "contractor payment".',
          },
          counterparty_name: {
            type: 'string',
            description: 'Optional name for the counterparty address (e.g. "OpenAI", "Alchemy", "ops wallet"). Stored permanently.',
          },
        },
        required: ['event_id', 'new_label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_financial_brief',
      description: "Get a structured financial brief — cash position, recent P&L, and any items needing attention. Use this for morning briefs, daily summaries, or 'how are we doing?' questions.",
      parameters: {
        type: 'object',
        properties: {
          period_days: {
            type: 'number',
            description: 'P&L period in days. Default 1 for a daily brief, 7 for weekly.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_alerts',
      description: 'Get recent alerts (large movements, spend spikes, treasury floor breaches, unusual gas). Use this to show what needs attention.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of alerts to return. Default 10.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_wallet',
      description: "Register a new wallet for tracking. Use this when the operator gives you a wallet address and asks you to watch it or start tracking it. This is a write operation.",
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'The wallet address (0x... for Base/EVM, base58 for Solana).',
          },
          chain: {
            type: 'string',
            enum: [...SUPPORTED_CHAINS],
            description: 'The chain this wallet is on. Default: base.',
          },
          label: {
            type: 'string',
            description: 'Optional human-readable label, e.g. "treasury", "ops wallet", "agent wallet 2".',
          },
          role: {
            type: 'string',
            enum: [...WALLET_ROLES],
            description: 'Optional role for this wallet.',
          },
        },
        required: ['address'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor — all calls are scoped to userId; no cross-user access possible
// ---------------------------------------------------------------------------

type ToolResult = Record<string, unknown> | unknown[];

export async function executeTool(
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (toolName) {
    case 'get_cash_position': {
      const valued = await getValuedBalances(userId);
      return {
        balances: valued.balances.map((b) => ({
          address: b.wallet_address,
          label: b.wallet_label,
          asset: b.asset,
          balance: b.balance,
          usd_value: b.usd_value,
          snapshot_at: b.snapshot_at,
        })),
        total_usd: valued.total_usd,
        total_incomplete: valued.total_incomplete,
        live_prices_usd: valued.prices,
      };
    }

    case 'get_books_summary': {
      const periodDays = (args.period_days as number | undefined) ?? 30;
      const [pnl, breakdown] = await Promise.all([
        getPnlSummary(userId, periodDays),
        getBooksSummary(userId, periodDays),
      ]);
      return { pnl, breakdown };
    }

    case 'get_recent_activity': {
      const limit = Math.min((args.limit as number | undefined) ?? 20, 50);
      const label = (args.label as string | undefined) ?? undefined;
      const periodDays = (args.period_days as number | undefined) ?? 7;
      const events = await getBooksEvents({
        userId,
        label: label ?? 'unknown',
        periodDays,
        limit,
      });
      if (label) {
        return { events };
      }
      // No label filter: use getEventsForReview for all recent events
      const allEvents = await getEventsForReview({ userId, limit });
      return { events: allEvents };
    }

    case 'get_wallets': {
      const res = await query<{
        id: string;
        address: string;
        label: string | null;
        chain: string;
        active: boolean;
        roles: string;
      }>(
        `SELECT w.id, w.address, w.label, w.chain, w.active,
                COALESCE(string_agg(wr.role, ', ' ORDER BY wr.role), '') AS roles
         FROM wallets w
         LEFT JOIN wallet_roles wr ON wr.wallet_id = w.id
         WHERE w.user_id = $1 AND w.active = true
         GROUP BY w.id, w.address, w.label, w.chain, w.active
         ORDER BY w.created_at`,
        [userId],
      );
      return {
        wallets: res.rows.map((r) => ({
          ...r,
          roles: r.roles ? r.roles.split(', ') : [],
        })),
      };
    }

    case 'get_wallet_balance': {
      const address = (args.address as string).toLowerCase();
      const res = await query<{
        asset: string;
        balance: string;
        snapshot_at: Date;
      }>(
        `SELECT DISTINCT ON (bs.asset)
           bs.asset, bs.balance::text AS balance, bs.snapshot_at
         FROM balance_snapshots bs
         JOIN wallets w ON w.id = bs.wallet_id
         WHERE bs.user_id = $1 AND w.address = $2 AND w.active = true
         ORDER BY bs.asset, bs.snapshot_at DESC`,
        [userId, address],
      );
      return { address, balances: res.rows };
    }

    case 'get_unknown_transactions': {
      const limit = (args.limit as number | undefined) ?? 20;
      const events = await getEventsForReview({ userId, label: 'unknown', limit });
      return { unknown_count: events.length, events };
    }

    case 'get_transaction': {
      const eventId = args.event_id as string;
      const event = await getEventWithClassification(eventId, userId);
      if (!event) return { error: 'Transaction not found' };
      return { event };
    }

    case 'apply_correction': {
      const eventId = args.event_id as string;
      const newLabel = args.new_label as ClassificationLabel;
      const reason = args.reason as string | undefined;
      const counterpartyName = args.counterparty_name as string | undefined;

      if (!(CLASSIFICATION_LABELS as ReadonlyArray<string>).includes(newLabel)) {
        return { error: `Invalid label: ${newLabel}` };
      }

      await applyCorrection({
        userId,
        eventId,
        newLabel,
        reason,
        counterpartyName,
      });
      return { success: true, event_id: eventId, new_label: newLabel };
    }

    case 'get_financial_brief': {
      const periodDays = (args.period_days as number | undefined) ?? 1;
      const [pnl, unknowns, alerts] = await Promise.all([
        getPnlSummary(userId, periodDays),
        getEventsForReview({ userId, label: 'unknown', limit: 5 }),
        query<{ type: string; message: string; created_at: Date }>(
          `SELECT type, message, created_at
           FROM alerts
           WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
           ORDER BY created_at DESC
           LIMIT 5`,
          [userId],
        ),
      ]);
      // Sum the latest USDC snapshot of EACH active wallet (not just the newest row overall).
      const cashRes = await query<{
        total: string;
        wallet_count: number;
      }>(
        `SELECT COALESCE(SUM(latest.balance), 0)::text AS total,
                COUNT(*)::int AS wallet_count
         FROM (
           SELECT DISTINCT ON (bs.wallet_id) bs.balance
           FROM balance_snapshots bs
           JOIN wallets w ON w.id = bs.wallet_id
           WHERE bs.user_id = $1 AND w.user_id = $1 AND bs.asset = 'USDC' AND w.active = true
           ORDER BY bs.wallet_id, bs.snapshot_at DESC
         ) latest`,
        [userId],
      );
      const cashRow = cashRes.rows[0];
      const valued = await getValuedBalances(userId);
      return {
        period_days: periodDays,
        cash_usdc: cashRow && cashRow.wallet_count > 0 ? cashRow.total : null,
        holdings_usd: valued.total_usd,
        holdings_incomplete: valued.total_incomplete,
        pnl,
        unknown_count: unknowns.length,
        recent_alerts: alerts.rows,
      };
    }

    case 'get_alerts': {
      const limit = (args.limit as number | undefined) ?? 10;
      const res = await query<{
        id: string;
        type: string;
        message: string;
        created_at: Date;
        sent_at: Date | null;
      }>(
        `SELECT id, type, message, created_at, sent_at
         FROM alerts
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit],
      );
      return { alerts: res.rows };
    }

    case 'register_wallet': {
      const address = (args.address as string).toLowerCase();
      const chain = (args.chain as string | undefined) ?? 'base';
      const label = (args.label as string | undefined) ?? null;
      const role = (args.role as string | undefined) ?? null;

      const BASE_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
      if (chain === 'base' && !BASE_ADDR_RE.test(args.address as string)) {
        return { error: 'Invalid Base address format — must be 0x + 40 hex chars' };
      }

      const walletRes = await query<{ id: string }>(
        `INSERT INTO wallets (user_id, address, chain, label)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, address, chain) DO UPDATE SET label = COALESCE(EXCLUDED.label, wallets.label)
         RETURNING id`,
        [userId, address, chain, label],
      );
      const walletId = walletRes.rows[0].id;

      await query(
        `INSERT INTO watch_jobs (user_id, wallet_id, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (wallet_id) DO NOTHING`,
        [userId, walletId],
      );

      if (role) {
        await query(
          `INSERT INTO wallet_roles (wallet_id, role)
           VALUES ($1, $2)
           ON CONFLICT (wallet_id, role) DO NOTHING`,
          [walletId, role],
        );
      }

      return { success: true, wallet_id: walletId, address, chain, label, role };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
