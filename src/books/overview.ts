import { query } from '../db.js';
import { usdValueSql } from '../ingestion/assets.js';
import { BRIEF_CATEGORIES } from '../types/index.js';
import { getPnlSummary, type PnlSummary } from './query.js';
import { getValuedBalances } from './balances.js';
import { getLedgerStatus, type LedgerStatus } from '../ledger/status.js';

const USD = usdValueSql('ne');
const COUNTERPARTY = `CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END`;

export type NeedsContext = {
  event_id: string;
  hash: string;
  direction: 'in' | 'out';
  asset: string | null;
  amount: string | null;
  usd_value: string | null;
  counterparty: string | null;
  block_time: Date;
};

export type FirstTimePayment = {
  counterparty: string;
  asset: string | null;
  amount: string | null;
  usd_value: string | null;
  block_time: Date;
};

export type Overview = {
  period_days: number;
  transaction_count: number;
  cash_usd: number;
  cash_incomplete: boolean;
  pnl: PnlSummary;
  internal_usd: number;
  unknown_usd: number;
  needs_context: { count: number; examples: NeedsContext[] };
  first_time_payments: FirstTimePayment[];
  // Last 7 days of spending vs the weekly average of the 4 weeks before; null without history
  spend_vs_usual: { last_7d_usd: number; usual_weekly_usd: number; ratio: number } | null;
  // Whether the books were proven against the chain; see src/ledger/reconcile.ts
  ledger: LedgerStatus;
};

function num(v: string | null | undefined): number {
  return v != null ? parseFloat(v) || 0 : 0;
}

// Everything behind a "what does the last month look like?" answer, from the ledger only.
export async function getOverview(userId: string, periodDays: number): Promise<Overview> {
  const [pnl, valued, ledger, totals, unknownRows, firstTime, spend] = await Promise.all([
    getPnlSummary(userId, periodDays),
    getValuedBalances(userId),
    getLedgerStatus(userId),
    query<{ transaction_count: number; internal_usd: string | null; unknown_usd: string | null }>(
      `SELECT COUNT(DISTINCT ne.hash)::int AS transaction_count,
              SUM(${USD}) FILTER (WHERE c.label::text = ANY($3::text[]))::text AS internal_usd,
              SUM(${USD}) FILTER (WHERE c.label::text = ANY($4::text[]))::text AS unknown_usd
       FROM normalized_events ne
       LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.user_id = $1 AND ne.supported IS TRUE
         AND ne.block_time >= NOW() - INTERVAL '1 day' * $2`,
      [userId, periodDays, BRIEF_CATEGORIES.internal, BRIEF_CATEGORIES.unknown],
    ),
    query<NeedsContext & { total: number }>(
      `SELECT ne.id AS event_id, ne.hash, ne.direction, ne.asset, ne.amount::text AS amount,
              ${USD}::text AS usd_value, ${COUNTERPARTY} AS counterparty, ne.block_time,
              COUNT(*) OVER ()::int AS total
       FROM normalized_events ne
       JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.user_id = $1 AND ne.supported IS TRUE
         AND c.label = 'unknown'
         AND ne.block_time >= NOW() - INTERVAL '1 day' * $2
       ORDER BY ${USD} DESC NULLS LAST, ne.block_time DESC
       LIMIT 3`,
      [userId, periodDays],
    ),
    // Outgoing payments in the last 7 days to an address this user had never paid before
    query<FirstTimePayment>(
      `SELECT ${COUNTERPARTY} AS counterparty, ne.asset, ne.amount::text AS amount,
              ${USD}::text AS usd_value, ne.block_time
       FROM normalized_events ne
       JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.user_id = $1 AND ne.supported IS TRUE
         AND ne.direction = 'out'
         AND ne.source_key <> 'gas'
         AND c.label::text <> ALL($2::text[])
         AND ne.block_time >= NOW() - INTERVAL '7 days'
         AND NOT EXISTS (
           SELECT 1 FROM normalized_events prev
           WHERE prev.user_id = ne.user_id AND prev.supported IS TRUE
             AND prev.direction = 'out'
             AND LOWER(prev.to_address) = LOWER(ne.to_address)
             AND prev.block_time < ne.block_time
         )
       ORDER BY ${USD} DESC NULLS LAST
       LIMIT 3`,
      [userId, BRIEF_CATEGORIES.internal],
    ),
    query<{ last_7d: string | null; prior_4w: string | null; has_history: boolean }>(
      `SELECT
         SUM(${USD}) FILTER (WHERE ne.block_time >= NOW() - INTERVAL '7 days')::text AS last_7d,
         SUM(${USD}) FILTER (WHERE ne.block_time < NOW() - INTERVAL '7 days')::text AS prior_4w,
         COALESCE(MIN(ne.block_time) <= NOW() - INTERVAL '28 days', FALSE) AS has_history
       FROM normalized_events ne
       JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.user_id = $1 AND ne.supported IS TRUE
         AND ne.direction = 'out'
         AND c.label::text = ANY($2::text[])
         AND ne.block_time >= NOW() - INTERVAL '35 days'`,
      [userId, BRIEF_CATEGORIES.expenses],
    ),
  ]);

  const t = totals.rows[0];
  const s = spend.rows[0];
  const usualWeekly = num(s?.prior_4w) / 4;
  const last7 = num(s?.last_7d);

  return {
    period_days: periodDays,
    transaction_count: t?.transaction_count ?? 0,
    cash_usd: valued.total_usd,
    cash_incomplete: valued.total_incomplete,
    pnl,
    internal_usd: num(t?.internal_usd),
    unknown_usd: num(t?.unknown_usd),
    needs_context: {
      count: unknownRows.rows[0]?.total ?? 0,
      examples: unknownRows.rows.map(({ total: _total, ...row }) => row),
    },
    first_time_payments: firstTime.rows,
    spend_vs_usual: s?.has_history && usualWeekly > 0
      ? { last_7d_usd: last7, usual_weekly_usd: usualWeekly, ratio: last7 / usualWeekly }
      : null,
    ledger,
  };
}
