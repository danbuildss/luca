import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { query } from '../db.js';
import { getPnlSummary, getBooksSummary, getBooksEvents } from '../books/query.js';
import { getValuedBalances } from '../books/balances.js';
import { getOverview } from '../books/overview.js';
import { getFigureBreakdown, FIGURES, type Figure } from '../books/breakdown.js';
import { getPreviousAnswers } from './traces.js';
import { getLedgerStatus } from '../ledger/status.js';
import { getEventsForReview, getEventWithClassification, resolveEventRef } from '../corrections/store.js';
import { applyCorrection, describeRuleOutcome } from '../corrections/handler.js';
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
      name: 'get_overview',
      description: 'The full picture for a period: transaction count, cash, revenue, expenses, gas, internal transfers, unknown amounts, and what needs attention (transfers needing context, first-time payees, spending vs usual). Use this for "what does the last month look like?", "how are we doing?" or any general overview.',
      parameters: {
        type: 'object',
        properties: {
          period_days: { type: 'number', description: 'Number of days to look back. Default 30.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_books_summary',
      description: 'Get a P&L summary (revenue, expenses, gas, net) over a given period, with the provisional (AI-guessed) part of revenue and expenses and the unknown, unpriced and pending counts. Use this for financial overviews, trend questions, or runway analysis.',
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
      name: 'get_figure_breakdown',
      description: 'Every transaction behind one figure (revenue, expenses, gas, internal, swaps, unknown, provisional or unpriced) for a period: date, amount, USD contribution, where its price came from, label, status and a BaseScan link. The rows add up exactly to the figure. Use this for "where does that number come from?", "show me those" or to check a total.',
      parameters: {
        type: 'object',
        properties: {
          figure: { type: 'string', enum: [...FIGURES], description: 'Which figure to break down.' },
          period_days: { type: 'number', description: 'Same period as the answer being explained. Default 30.' },
        },
        required: ['figure'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_previous_answers',
      description: 'Your last few answers to this operator, each with the question and the exact tool calls (periods, filters) behind it. Use it for follow-ups like "where does that come from?" or "show me those", so you break down exactly the figures you gave.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'How many answers, newest first. Default 3.' } },
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
      description: 'Get full details for a specific transaction by its event ID: its label, status (confirmed, provisional or unknown), evidence, and the rule that labeled it. Use this to investigate a movement or to explain why it is labeled the way it is.',
      parameters: {
        type: 'object',
        properties: {
          event_id: {
            type: 'string',
            description: 'The event id from another tool result, or the transaction hash (full or shortened).',
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
            description: 'The event id from another tool result, or the transaction hash (full or shortened) the operator gave.',
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
// Write-tool preparation — runs before an action is shown for confirmation, so the
// user is never asked to confirm something that cannot succeed, and the confirmed
// action targets exactly the transaction that was shown.
// ---------------------------------------------------------------------------

export type PreparedWrite =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string; candidates?: unknown[] };

export async function prepareWriteAction(
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<PreparedWrite> {
  if (toolName !== 'apply_correction') return { ok: true, args };

  if (!(CLASSIFICATION_LABELS as ReadonlyArray<string>).includes(String(args.new_label))) {
    return { ok: false, error: `Invalid label: ${String(args.new_label)}` };
  }
  const ref = await resolveEventRef(userId, argText(args.event_id));
  if (ref.status === 'not_found') {
    return {
      ok: false,
      error: 'No matching transaction. Look it up with get_recent_activity and use its id, or ask the operator for the full transaction hash.',
    };
  }
  if (ref.status === 'ambiguous') {
    return {
      ok: false,
      error: 'More than one transfer matches. Ask the operator which one, then use its id.',
      candidates: ref.candidates,
    };
  }
  return { ok: true, args: { ...args, event_id: ref.event.id, tx_hash: ref.event.hash } };
}

// Tool arguments come from the model: only a string or number is a usable id or name
function argText(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

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
      const [valued, ledger] = await Promise.all([getValuedBalances(userId), getLedgerStatus(userId)]);
      return {
        ledger,
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

    case 'get_overview': {
      const periodDays = (args.period_days as number | undefined) ?? 30;
      return await getOverview(userId, periodDays);
    }

    case 'get_books_summary': {
      const periodDays = (args.period_days as number | undefined) ?? 30;
      const [pnl, breakdown, ledger] = await Promise.all([
        getPnlSummary(userId, periodDays),
        getBooksSummary(userId, periodDays),
        getLedgerStatus(userId),
      ]);
      return { pnl, breakdown, ledger };
    }

    case 'get_figure_breakdown': {
      const figure = argText(args.figure) as Figure;
      if (!(FIGURES as readonly string[]).includes(figure)) return { error: `Unknown figure: ${figure}` };
      const periodDays = (args.period_days as number | undefined) ?? 30;
      return await getFigureBreakdown(userId, figure, periodDays);
    }

    case 'get_previous_answers': {
      return { answers: await getPreviousAnswers(userId, (args.limit as number | undefined) ?? 3) };
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
      const ref = await resolveEventRef(userId, argText(args.event_id));
      if (ref.status === 'not_found') return { error: 'Transaction not found' };
      if (ref.status === 'ambiguous') {
        return { error: 'More than one transfer matches; pick one by id', candidates: ref.candidates };
      }
      const event = await getEventWithClassification(ref.event.id, userId);
      if (!event) return { error: 'Transaction not found' };
      return { event: { ...event, hash: ref.event.hash } };
    }

    case 'apply_correction': {
      const newLabel = args.new_label as ClassificationLabel;
      const reason = args.reason as string | undefined;
      const counterpartyName = args.counterparty_name as string | undefined;

      if (!(CLASSIFICATION_LABELS as ReadonlyArray<string>).includes(newLabel)) {
        return { error: `Invalid label: ${newLabel}` };
      }
      const ref = await resolveEventRef(userId, argText(args.event_id));
      if (ref.status !== 'found') return { error: 'Transaction not found' };

      const result = await applyCorrection({
        userId,
        eventId: ref.event.id,
        newLabel,
        reason,
        counterpartyName,
      });
      return { success: true, event_id: ref.event.id, new_label: newLabel, note: describeRuleOutcome(result.rule) };
    }

    case 'get_financial_brief': {
      const periodDays = (args.period_days as number | undefined) ?? 1;
      const [overview, alerts] = await Promise.all([
        getOverview(userId, periodDays),
        query<{ type: string; message: string; certainty: string | null; created_at: Date }>(
          `SELECT type, message, certainty, created_at
           FROM alerts
           WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
           ORDER BY created_at DESC
           LIMIT 5`,
          [userId],
        ),
      ]);
      return { ...overview, recent_alerts: alerts.rows };
    }

    case 'get_alerts': {
      const limit = (args.limit as number | undefined) ?? 10;
      const res = await query<{
        id: string;
        type: string;
        message: string;
        certainty: string | null;
        created_at: Date;
        sent_at: Date | null;
      }>(
        `SELECT id, type, message, certainty, created_at, sent_at
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
