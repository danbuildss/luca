import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { query } from '../db.js';
import { getPnlSummary, getBooksSummary } from '../books/query.js';
import { getRecentActivity } from '../books/activity.js';
import { getValuedBalances } from '../books/balances.js';
import { getOverview } from '../books/overview.js';
import { getFigureBreakdown, FIGURES, significant, type Figure } from '../books/breakdown.js';
import { getPreviousAnswers } from './traces.js';
import { getLedgerStatus } from '../ledger/status.js';
import { getEventsForReview, getEventWithClassification, resolveEventRef } from '../corrections/store.js';
import { applyCorrection, describeRuleOutcome } from '../corrections/handler.js';
import { txLink, withLink } from '../ledger/links.js';
import { ClassificationLabel, CLASSIFICATION_LABELS, WALLET_ROLES, SUPPORTED_CHAINS } from '../types/index.js';
import { requestAudit, auditRequestForModel, movementStatus, amountText, isMissing } from '../ledger/audit-runs.js';
import { traceTransaction } from '../ledger/trace.js';
import { config } from '../config.js';
import { skipQuestionGroup } from '../alerts/questions.js';
import { feeReport, feeMachineReportText } from '../fees/report.js';

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
      description: 'Get recent transactions with their labels, newest first, for a period. Use this for "show me my recent transactions", "what happened this week?" or questions about specific movements. Results are grouped by on-chain transaction, each with its movements (a swap is one transaction with ETH out, BNKR in and a network fee). `covers` says what the list includes: all transactions or one label, the period, and how many transactions and movements; describe the list by it, and never call a filtered list everything that happened. Each transaction has a ready-made `link` and each movement `amount_display` and `usd_display`, to show as they are.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of on-chain transactions to return. Default 20, max 50.',
          },
          label: {
            type: 'string',
            enum: [...CLASSIFICATION_LABELS],
            description: 'Only when the operator asks for one category (e.g. "show me my expenses"). Omit it for recent transactions in general.',
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
      name: 'label_question_group',
      description: 'Label a group of transfers Luca asked about (listed under "Open Questions" as a group) with what the operator said they were, for example "those are expenses" or "that was infrastructure" (expense). Nothing changes yet: Luca asks the operator to confirm in its own words. If it is unclear which group they mean or what they were, ask instead.',
      parameters: {
        type: 'object',
        properties: {
          group_id: { type: 'string', description: 'The id of the group from Open Questions.' },
          label: { type: 'string', enum: CLASSIFICATION_LABELS.filter((l) => l !== 'unknown'), description: 'What the operator said the transfers were.' },
        },
        required: ['group_id', 'label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skip_question_group',
      description: 'Stop asking about a group of transfers for now, when the operator says they do not know or want to skip it ("not sure", "skip that", "ask me later"). Changes nothing in the books.',
      parameters: {
        type: 'object',
        properties: { group_id: { type: 'string', description: 'The id of the group from Open Questions.' } },
        required: ['group_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'answer_proposal',
      description: 'Answer one of your open questions about earlier transfers (listed under "Open Questions") when the operator\'s message clearly answers it, for example "yes, update those 6 payments" or "no, leave the old ones as they are". Never call it for a bare "yes" or "no", and never when it is unclear which question they mean: ask instead. The result says exactly what changed; relay it as given.',
      parameters: {
        type: 'object',
        properties: {
          proposal_id: { type: 'string', description: 'The id of the open question the operator answered.' },
          accept: { type: 'boolean', description: 'true when they said yes, false when they said no.' },
        },
        required: ['proposal_id', 'accept'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_books_complete',
      description: "Check that everything the chain shows for the operator's own wallets reached their books: nothing missing, nothing stuck unlabeled or unpriced. Use for \"are my books complete?\", \"are you missing anything?\", \"check my wallets\", \"check everything\". By default it checks everything Luca has tracked: leave days out unless the operator names a period. The check runs in the background and its result is sent as its own message; a recent result is returned directly when nothing has changed.",
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Only when the operator names a period ("yesterday", "this week", "last 3 days"): the number of days. Leave out otherwise; the default is everything tracked.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_transaction',
      description: "Check whether one transaction reached the operator's books and how it is recorded, or where it got lost. Use for \"did you see transaction 0x…?\" or \"why isn't this payment in my books?\". Only the operator's own wallets are shown.",
      parameters: {
        type: 'object',
        properties: { hash: { type: 'string', description: 'The full transaction hash (0x followed by 64 hex characters).' } },
        required: ['hash'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_creator_fees',
      description: "The creator fees Luca follows for the operator (e.g. $ACCUM trading fees paid in BNKR by Bankr): what Bankr reports as claimable and claimed, claims verified on-chain, whether they match, and the fee wallet's balance. Use for any question about ACCUM, creator fees, Bankr fees, claimable or claimed fees, or fee activity. The reply is sent to the operator exactly as the tool writes it. Luca only reads: it never claims, stakes or moves these fees.",
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['summary', 'machine'], description: "'machine' only when the operator asks for the machine report or JSON; otherwise leave out." },
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
            description: 'The Base wallet address (0x followed by 40 hex characters).',
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

// A transaction row with its link and a ready-made rounded amount ("0.0014997 ETH"), so an
// answer never shows a raw 18-decimal amount
function shown<T extends { hash: string; amount?: string | number | null; asset?: string | null }>(row: T): T & { link: string; amount_display: string | null } {
  const n = row.amount == null ? NaN : typeof row.amount === 'number' ? row.amount : parseFloat(row.amount);
  return { ...withLink(row), amount_display: Number.isFinite(n) ? `${significant(n)} ${row.asset ?? ''}`.trim() : null };
}

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
  // Checked before Luca asks the operator to confirm, so the operator never confirms a wallet
  // Luca cannot track
  if (toolName === 'register_wallet') {
    if ((args.chain ?? 'base') !== 'base') return { ok: false, error: 'Luca only tracks wallets on Base.' };
    if (!/^0x[0-9a-fA-F]{40}$/.test(argText(args.address))) {
      return { ok: false, error: 'That is not a Base wallet address (0x followed by 40 hex characters).' };
    }
    return { ok: true, args };
  }
  if (toolName === 'label_question_group') {
    const label = String(args.label);
    if (!(CLASSIFICATION_LABELS as ReadonlyArray<string>).includes(label) || label === 'unknown') {
      return { ok: false, error: `Invalid label: ${label}` };
    }
    const groupId = argText(args.group_id);
    const open = /^[0-9a-f-]{36}$/i.test(groupId) ? (await query<{ id: string }>(
      `SELECT id FROM question_groups WHERE id = $1 AND user_id = $2 AND status IN ('open', 'skipped') AND event_count > 0`,
      [groupId, userId],
    )).rows[0] : undefined;
    if (!open) return { ok: false, error: 'That group is not open any more. Check Open Questions, or ask the operator which transfers they mean.' };
    return { ok: true, args: { group_id: groupId, label } };
  }
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
      candidates: ref.candidates.map(shown),
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
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : 20;
      const label = typeof args.label === 'string' ? args.label : null;
      const periodDays = typeof args.period_days === 'number' && args.period_days > 0 ? Math.min(args.period_days, 365) : 7;
      const valid = label && (CLASSIFICATION_LABELS as ReadonlyArray<string>).includes(label) ? label : null;
      return await getRecentActivity({ userId, label: valid, periodDays, limit });
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
      return { unknown_count: events.length, events: events.map(shown) };
    }

    case 'get_transaction': {
      const ref = await resolveEventRef(userId, argText(args.event_id));
      if (ref.status === 'not_found') return { error: 'Transaction not found' };
      if (ref.status === 'ambiguous') {
        return { error: 'More than one transfer matches; pick one by id', candidates: ref.candidates.map(shown) };
      }
      const event = await getEventWithClassification(ref.event.id, userId);
      if (!event) return { error: 'Transaction not found' };
      return { event: shown({ ...event, hash: ref.event.hash }) };
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
      return {
        success: true, event_id: ref.event.id, new_label: newLabel, link: txLink(ref.event.hash),
        note: describeRuleOutcome(result.rule),
      };
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
      if (chain !== 'base') {
        return { error: 'Luca only tracks wallets on Base.' };
      }
      if (!BASE_ADDR_RE.test(args.address as string)) {
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

    case 'label_question_group':
      // Only ever applied after the operator confirms (src/agent/changes.ts)
      return { error: 'This change needs the operator\'s confirmation first.' };

    case 'skip_question_group': {
      const groupId = argText(args.group_id);
      if (!/^[0-9a-f-]{36}$/i.test(groupId)) return { error: 'Unknown group' };
      await skipQuestionGroup(groupId, userId);
      return { skipped: true, note: 'I will not ask about these again unless more transfers like them arrive.' };
    }

    case 'answer_proposal':
      // Answered only in the agent loop, against the operator's own message (src/agent/run.ts)
      return { error: 'This can only be answered from the operator\'s own message.' };

    case 'check_books_complete': {
      const days = typeof args.days === 'number' ? args.days : null;
      return auditRequestForModel(await requestAudit({ userId, requestedBy: userId, days }));
    }

    case 'get_creator_fees':
      return { report: args.format === 'machine' ? await feeMachineReportText(userId) : await feeReport(userId) };

    case 'check_transaction': {
      const hash = argText(args.hash).trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return { error: 'Ask the operator for the full transaction hash: 0x followed by 64 hex characters.' };
      const trace = await traceTransaction(hash, config.ALCHEMY_API_KEY);
      const own = await query<{ id: string }>(`SELECT id FROM wallets WHERE user_id = $1`, [userId]);
      const mine = new Set(own.rows.map((r) => r.id));
      // Only the operator's own wallets: say nothing about anyone else's
      const movements = trace.movements.filter((m) => m.wallet_id && mine.has(m.wallet_id));
      if (movements.length === 0) {
        return { found: false, note: "This transaction does not involve any of the operator's wallets, or it does not exist on Base." };
      }
      return {
        found: true,
        link: txLink(hash),
        failed_on_chain: trace.status === 'failed',
        chain_checked: trace.checked_chain,
        movements: movements.map((m) => ({
          wallet: `${m.wallet.slice(0, 6)}…${m.wallet.slice(-4)}`,
          what: m.source_key === 'gas' ? 'network fee' : m.source_key,
          amount: amountText(m),
          direction: m.direction,
          usd_value: m.usd_value,
          label: m.label,
          status: movementStatus(m),
          missing: isMissing(m.lost_at),
        })),
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
