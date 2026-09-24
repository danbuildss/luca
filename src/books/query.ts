import { query } from '../db.js';
import type { ClassificationLabel } from '../types/index.js';
import { BRIEF_CATEGORIES } from '../types/index.js';
import { usdValueSql } from '../ingestion/assets.js';

export type BooksSummaryRow = {
  label: string;
  direction: 'in' | 'out' | null;
  event_count: number;
  total_usdc: string | null; // NUMERIC comes back as string from pg
  // Part of total_usdc that is the AI's guess, not confirmed
  provisional_usdc: string | null;
};

export type BooksEvent = {
  id: string;
  hash: string;
  block_time: Date;
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: string | null;
  usd_value: string | null;
  direction: 'in' | 'out';
  label: ClassificationLabel;
  confidence: string;
  status: 'confirmed' | 'provisional' | 'unknown';
};

const USD_COALESCE = usdValueSql('ne');

export async function getBooksSummary(userId: string, periodDays: number): Promise<BooksSummaryRow[]> {
  const res = await query<BooksSummaryRow>(
    `SELECT c.label,
            ne.direction,
            COUNT(*)::int            AS event_count,
            SUM(${USD_COALESCE})     AS total_usdc,
            SUM(${USD_COALESCE}) FILTER (WHERE c.status = 'provisional') AS provisional_usdc
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND c.superseded_at IS NULL
       AND ne.block_time >= NOW() - INTERVAL '1 day' * $2
     GROUP BY c.label, ne.direction
     ORDER BY c.label, ne.direction`,
    [userId, periodDays],
  );
  return res.rows;
}

export async function getBooksEvents(params: {
  userId: string;
  label: string;
  periodDays: number;
  limit: number;
}): Promise<BooksEvent[]> {
  const res = await query<BooksEvent>(
    `SELECT ne.id, ne.hash, ne.block_time, ne.from_address, ne.to_address,
            ne.asset, ne.amount, ne.usd_value, ne.direction,
            c.label, c.confidence, c.status
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND c.label = $2::classification_label
       AND c.superseded_at IS NULL
       AND ne.block_time >= NOW() - INTERVAL '1 day' * $3
     ORDER BY ne.block_time DESC
     LIMIT $4`,
    [params.userId, params.label, params.periodDays, params.limit],
  );
  return res.rows;
}

export type PnlSummary = {
  period_days: number;
  revenue_usdc: number;
  expenses_usdc: number;
  gas_usdc: number;
  net_usdc: number;
  // Parts of revenue and expenses that are the AI's guesses (status provisional)
  revenue_provisional_usdc: number;
  expenses_provisional_usdc: number;
  // Labeled transfers that are the AI's guesses, in any category
  provisional_count: number;
  // Transfers that need the operator's answer
  unknown_count: number;
  // Transfers in the totals' categories (or unknown) with no USD price yet
  unpriced_count: number;
  // Supported transfers in the period not classified yet, so not in the totals above
  pending_count: number;
};

// Direction-aware P&L totals. Money flowing against a category's natural direction nets
// it down: a revenue-labelled 'out' (customer refund) reduces revenue, an expense/gas-
// labelled 'in' (vendor refund) reduces expenses/gas. Refunds net the same way: one sent
// reduces revenue, one received reduces expenses. Internal transfers, treasury moves and
// swaps are not in P&L (a swap's gas is).
// Label lists inlined as SQL literals (constants, never user input)
const labels = (list: readonly string[]): string => list.map((l) => `'${l}'`).join(', ');

// Each transfer's signed contribution to a P&L figure (NULL when it is not part of it).
// Shared by the totals and by the per-transaction breakdown, so the two always agree.
export const REVENUE_SQL = `CASE
    WHEN c.label IN (${labels(BRIEF_CATEGORIES.revenue)}) THEN CASE WHEN ne.direction = 'out' THEN -${USD_COALESCE} ELSE ${USD_COALESCE} END
    WHEN c.label = 'refund' AND ne.direction = 'out' THEN -${USD_COALESCE}
  END`;
export const EXPENSES_SQL = `CASE
    WHEN c.label IN (${labels(BRIEF_CATEGORIES.expenses)}) THEN CASE WHEN ne.direction = 'in' THEN -${USD_COALESCE} ELSE ${USD_COALESCE} END
    WHEN c.label = 'refund' AND ne.direction = 'in' THEN -${USD_COALESCE}
  END`;
export const GAS_SQL = `CASE
    WHEN c.label IN (${labels(BRIEF_CATEGORIES.gas)}) THEN CASE WHEN ne.direction = 'in' THEN -${USD_COALESCE} ELSE ${USD_COALESCE} END
  END`;

export async function getPnlSummary(userId: string, periodDays: number): Promise<PnlSummary> {
  const REVENUE = REVENUE_SQL;
  const EXPENSES = EXPENSES_SQL;
  const res = await query<{
    revenue_usdc: string | null;
    expenses_usdc: string | null;
    gas_usdc: string | null;
    revenue_provisional_usdc: string | null;
    expenses_provisional_usdc: string | null;
    provisional_count: number | null;
    unknown_count: number | null;
    unpriced_count: number | null;
    pending_count: number | null;
  }>(
    `SELECT
       SUM(${REVENUE})::text AS revenue_usdc,
       SUM(${EXPENSES})::text AS expenses_usdc,
       SUM(${GAS_SQL})::text AS gas_usdc,
       SUM(${REVENUE}) FILTER (WHERE c.status = 'provisional')::text AS revenue_provisional_usdc,
       SUM(${EXPENSES}) FILTER (WHERE c.status = 'provisional')::text AS expenses_provisional_usdc,
       (COUNT(*) FILTER (WHERE c.status = 'provisional'))::int AS provisional_count,
       (COUNT(*) FILTER (WHERE c.label = 'unknown' AND c.source IS DISTINCT FROM 'failure'))::int AS unknown_count,
       (COUNT(*) FILTER (WHERE ${USD_COALESCE} IS NULL AND c.source IS DISTINCT FROM 'failure'
                           AND c.label NOT IN (${labels([...BRIEF_CATEGORIES.internal, ...BRIEF_CATEGORIES.conversion])})))::int AS unpriced_count,
       (COUNT(*) FILTER (WHERE c.id IS NULL OR c.source = 'failure'))::int AS pending_count
     FROM normalized_events ne
     LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND ne.block_time >= NOW() - INTERVAL '1 day' * $2`,
    [userId, periodDays],
  );

  const row = res.rows[0];
  const num = (v: string | null | undefined): number => (v != null ? parseFloat(v) || 0 : 0);
  const revenue = num(row?.revenue_usdc);
  const expenses = num(row?.expenses_usdc);
  const gas = num(row?.gas_usdc);

  return {
    period_days: periodDays,
    revenue_usdc: revenue,
    expenses_usdc: expenses,
    gas_usdc: gas,
    net_usdc: revenue - expenses - gas,
    revenue_provisional_usdc: num(row?.revenue_provisional_usdc),
    expenses_provisional_usdc: num(row?.expenses_provisional_usdc),
    provisional_count: row?.provisional_count ?? 0,
    unknown_count: row?.unknown_count ?? 0,
    unpriced_count: row?.unpriced_count ?? 0,
    pending_count: row?.pending_count ?? 0,
  };
}
