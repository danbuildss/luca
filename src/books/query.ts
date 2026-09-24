import { query } from '../db.js';
import type { ClassificationLabel } from '../types/index.js';
import { BRIEF_CATEGORIES } from '../types/index.js';

export type BooksSummaryRow = {
  label: string;
  direction: 'in' | 'out' | null;
  event_count: number;
  total_usdc: string | null; // NUMERIC comes back as string from pg
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
};

// usd_value when available; for USDC treat amount as 1:1; otherwise null
const USD_COALESCE = `COALESCE(ne.usd_value, CASE WHEN ne.asset = 'USDC' THEN ne.amount ELSE NULL END)`;

export async function getBooksSummary(userId: string, periodDays: number): Promise<BooksSummaryRow[]> {
  const res = await query<BooksSummaryRow>(
    `SELECT c.label,
            ne.direction,
            COUNT(*)::int            AS event_count,
            SUM(${USD_COALESCE})     AS total_usdc
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     WHERE ne.user_id = $1
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
            c.label, c.confidence
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     WHERE ne.user_id = $1
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
  unknown_count: number;
};

// Direction-aware P&L totals. Money flowing against a category's natural
// direction nets it down: a revenue-labelled 'out' (customer refund) reduces
// revenue, an expense/gas-labelled 'in' (vendor refund) reduces expenses/gas.
// internal / treasury / refund labels are excluded from P&L.
export async function getPnlSummary(userId: string, periodDays: number): Promise<PnlSummary> {
  const res = await query<{
    revenue_usdc: string | null;
    expenses_usdc: string | null;
    gas_usdc: string | null;
    unknown_count: number | null;
  }>(
    `SELECT
       SUM(CASE WHEN c.label::text = ANY($3::text[])
                THEN CASE WHEN ne.direction = 'out' THEN -${USD_COALESCE} ELSE ${USD_COALESCE} END
           END)::text AS revenue_usdc,
       SUM(CASE WHEN c.label::text = ANY($4::text[])
                THEN CASE WHEN ne.direction = 'in' THEN -${USD_COALESCE} ELSE ${USD_COALESCE} END
           END)::text AS expenses_usdc,
       SUM(CASE WHEN c.label::text = ANY($5::text[])
                THEN CASE WHEN ne.direction = 'in' THEN -${USD_COALESCE} ELSE ${USD_COALESCE} END
           END)::text AS gas_usdc,
       (COUNT(*) FILTER (WHERE c.label::text = ANY($6::text[])))::int AS unknown_count
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     WHERE ne.user_id = $1
       AND c.superseded_at IS NULL
       AND ne.block_time >= NOW() - INTERVAL '1 day' * $2`,
    [
      userId,
      periodDays,
      BRIEF_CATEGORIES.revenue,
      BRIEF_CATEGORIES.expenses,
      BRIEF_CATEGORIES.gas,
      BRIEF_CATEGORIES.unknown,
    ],
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
    unknown_count: row?.unknown_count ?? 0,
  };
}
