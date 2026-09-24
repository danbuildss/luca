import { query } from '../db.js';
import { usdValueSql } from '../ingestion/assets.js';
import { BRIEF_CATEGORIES } from '../types/index.js';
import { REVENUE_SQL, EXPENSES_SQL, GAS_SQL } from './query.js';

// Every transaction behind one figure, so any number Luca gives can be traced to the
// chain. Revenue, expenses and gas use the exact expressions getPnlSummary sums, so the
// rows always add up to the figure reported.
export const FIGURES = ['revenue', 'expenses', 'gas', 'internal', 'swaps', 'unknown', 'provisional', 'unpriced'] as const;
export type Figure = (typeof FIGURES)[number];

const USD = usdValueSql('ne');
const list = (labels: readonly string[]): string => labels.map((l) => `'${l}'`).join(', ');

// Signed contribution of a transfer to the figure; NULL = not part of it.
const CONTRIBUTION: Record<Figure, string> = {
  revenue: REVENUE_SQL,
  expenses: EXPENSES_SQL,
  gas: GAS_SQL,
  internal: `CASE WHEN c.label IN (${list(BRIEF_CATEGORIES.internal)}) THEN COALESCE(${USD}, 0) END`,
  swaps: `CASE WHEN c.label IN (${list(BRIEF_CATEGORIES.conversion)}) THEN COALESCE(${USD}, 0) END`,
  unknown: `CASE WHEN c.label = 'unknown' AND c.source IS DISTINCT FROM 'failure' THEN COALESCE(${USD}, 0) END`,
  provisional: `CASE WHEN c.status = 'provisional' THEN COALESCE(${USD}, 0) END`,
  unpriced: `CASE WHEN ${USD} IS NULL AND c.source IS DISTINCT FROM 'failure'
                   AND c.label NOT IN (${list([...BRIEF_CATEGORIES.internal, ...BRIEF_CATEGORIES.conversion])}) THEN 0 END`,
};

export type BreakdownRow = {
  date: Date;
  direction: 'in' | 'out';
  asset: string | null;
  amount: string | null;
  usd: string | null;        // the transfer's signed contribution to the figure
  price_source: string | null;
  price_ref: string | null;
  label: string;
  status: string;
  counterparty: string | null;
  hash: string;
  basescan: string;
};

export type Breakdown = {
  figure: Figure;
  period_days: number;
  total_usd: number;
  count: number;
  // Largest first; `truncated` says there are more than listed (the total covers all)
  rows: BreakdownRow[];
  truncated: boolean;
};

export async function getFigureBreakdown(
  userId: string,
  figure: Figure,
  periodDays: number,
  limit = 50,
): Promise<Breakdown> {
  const contribution = CONTRIBUTION[figure];
  const res = await query<Omit<BreakdownRow, 'basescan'> & { total: string | null; n: number }>(
    `SELECT * FROM (
       SELECT ne.block_time AS date, ne.direction, ne.asset, ne.amount::text AS amount,
              (${contribution})::text AS usd, ne.price_source, ne.price_ref,
              c.label::text AS label, c.status,
              CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END AS counterparty,
              ne.hash,
              SUM(${contribution}) OVER ()::text AS total,
              COUNT(*) OVER ()::int AS n,
              ABS(${contribution}) AS size
       FROM normalized_events ne
       JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.user_id = $1
         AND ne.supported IS TRUE
         AND ne.block_time >= NOW() - INTERVAL '1 day' * $2
         AND (${contribution}) IS NOT NULL
     ) t
     ORDER BY size DESC NULLS LAST, date DESC
     LIMIT $3`,
    [userId, periodDays, limit],
  );
  const first = res.rows[0];
  return {
    figure,
    period_days: periodDays,
    total_usd: first?.total != null ? parseFloat(first.total) : 0,
    count: first?.n ?? 0,
    rows: res.rows.map((r) => ({
      date: r.date, direction: r.direction, asset: r.asset, amount: r.amount, usd: r.usd,
      price_source: r.price_source, price_ref: r.price_ref, label: r.label, status: r.status,
      counterparty: r.counterparty, hash: r.hash, basescan: `https://basescan.org/tx/${r.hash}`,
    })),
    truncated: (first?.n ?? 0) > res.rows.length,
  };
}
