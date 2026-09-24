import { query } from '../db.js';
import { getPnlSummary } from '../books/query.js';
import { escapeLegacyMarkdown, figuresBlock } from '../telegram/format.js';
import { usdValueSql } from '../ingestion/assets.js';

// Unpriced rows count as 0 so totals and ORDER BY never see NULL
const USD_OR_ZERO = `COALESCE(${usdValueSql('ne')}, 0)`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function pct(current: number, prior: number): string {
  if (prior === 0) return current > 0 ? '+∞%' : '—';
  // abs() so a negative prior (e.g. net loss) doesn't flip the sign of the change
  const change = ((current - prior) / Math.abs(prior)) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(0)}%`;
}

// Unsigned magnitude — callers prefix the sign for fixed-direction lines
function usd(amount: number): string {
  return `$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Signed amount: "+$10.00" / "-$50.00". Values that round to zero get
// `zeroSign` (cost lines pass '-' so an empty Expenses line reads "-$0.00").
function signedUsd(amount: number, zeroSign: '+' | '-' = '+'): string {
  const rounded = Math.round(amount * 100) / 100;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : zeroSign;
  return `${sign}${usd(rounded)}`;
}

// Format a date in the user's timezone; falls back to server time on a bad/absent zone
function formatDate(date: Date, opts: Intl.DateTimeFormatOptions, timezone?: string): string {
  try {
    return date.toLocaleDateString('en-US', { ...opts, timeZone: timezone });
  } catch {
    return date.toLocaleDateString('en-US', opts);
  }
}

function counterpartyLabel(cp: TopCounterparty): string {
  const raw = cp.name ?? `${cp.address.slice(0, 6)}…${cp.address.slice(-4)}`;
  // Pad before escaping so the backslashes don't eat into the column width
  return escapeLegacyMarkdown(raw.slice(0, 20).padEnd(20));
}

type TopCounterparty = {
  address: string;
  name: string | null;
  total_usdc: string;
};

async function getTopCounterparties(userId: string, periodDays: number, limit = 3): Promise<TopCounterparty[]> {
  const res = await query<TopCounterparty>(
    `SELECT
       CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END AS address,
       cr.name,
       SUM(${USD_OR_ZERO})::text AS total_usdc
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     -- One rule per event: a same-direction rule wins over a legacy (NULL) one
     LEFT JOIN LATERAL (
       SELECT r.name FROM counterparty_rules r
       WHERE r.user_id = ne.user_id
         AND r.address = LOWER(CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END)
         AND (r.direction = ne.direction OR r.direction IS NULL)
       ORDER BY r.direction NULLS LAST
       LIMIT 1
     ) cr ON TRUE
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND c.superseded_at IS NULL
       AND c.label IN ('revenue', 'expense', 'x402_income', 'x402_spend')
       AND ne.block_time >= NOW() - INTERVAL '1 day' * $2
     GROUP BY address, cr.name
     ORDER BY SUM(${USD_OR_ZERO}) DESC
     LIMIT $3`,
    [userId, periodDays, limit],
  );
  return res.rows;
}

async function getUnknownCount(userId: string, periodDays: number): Promise<number> {
  const res = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND c.superseded_at IS NULL
       AND c.label = 'unknown'
       AND ne.block_time >= NOW() - INTERVAL '1 day' * $2`,
    [userId, periodDays],
  );
  return parseInt(res.rows[0]?.cnt ?? '0', 10);
}

// Counterparty names are user-set, so they stay outside the monospace block where
// Markdown escaping applies.
function appendCounterpartiesAndUnknowns(
  lines: string[],
  topCounterparties: TopCounterparty[],
  unknownCount: number,
): void {
  if (topCounterparties.length > 0) {
    lines.push(``, `Top counterparties`);
    for (const cp of topCounterparties) {
      lines.push(`- ${counterpartyLabel(cp)} ${usd(parseFloat(cp.total_usdc))}`);
    }
  }
  if (unknownCount > 0) {
    const one = unknownCount === 1;
    lines.push(
      ``,
      `${unknownCount} unknown ${one ? 'transfer needs' : 'transfers need'} context. Reply here and tell me what ${one ? 'it was' : 'they were'}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Daily brief
// ---------------------------------------------------------------------------

// `timezone` (IANA) localises the header date; omitted → server timezone
export async function generateDailyBrief(userId: string, timezone?: string): Promise<string> {
  const [today, yesterday, unknownCount, topCounterparties] = await Promise.all([
    getPnlSummary(userId, 1),
    getPnlSummary(userId, 2),
    getUnknownCount(userId, 1),
    getTopCounterparties(userId, 1, 3),
  ]);

  // yesterday-only figures = 2-day total minus today
  const priorRevenue = yesterday.revenue_usdc - today.revenue_usdc;
  const priorExpenses = yesterday.expenses_usdc - today.expenses_usdc;

  const revChange = pct(today.revenue_usdc, priorRevenue);
  const expChange = pct(today.expenses_usdc, priorExpenses);

  const dateStr = formatDate(new Date(), {
    weekday: 'short', month: 'short', day: 'numeric',
  }, timezone);

  const lines: string[] = [
    `*Daily brief, ${dateStr}*`,
    ``,
    figuresBlock([
      ['Revenue', signedUsd(today.revenue_usdc)],
      ['Expenses', signedUsd(-today.expenses_usdc, '-')],
      ['Gas', signedUsd(-today.gas_usdc, '-')],
      ['Net', signedUsd(today.net_usdc)],
    ]),
    ``,
    `Compared with yesterday: ${revChange} revenue, ${expChange} expenses.`,
  ];

  appendCounterpartiesAndUnknowns(lines, topCounterparties, unknownCount);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Weekly brief
// ---------------------------------------------------------------------------

export async function generateWeeklyBrief(userId: string, timezone?: string): Promise<string> {
  const [thisWeek, twoWeeks, unknownCount, topCounterparties] = await Promise.all([
    getPnlSummary(userId, 7),
    getPnlSummary(userId, 14),
    getUnknownCount(userId, 7),
    getTopCounterparties(userId, 7, 5),
  ]);

  const priorRevenue = twoWeeks.revenue_usdc - thisWeek.revenue_usdc;
  const priorExpenses = twoWeeks.expenses_usdc - thisWeek.expenses_usdc;

  const revChange = pct(thisWeek.revenue_usdc, priorRevenue);
  const expChange = pct(thisWeek.expenses_usdc, priorExpenses);
  const netChange = pct(thisWeek.net_usdc, twoWeeks.net_usdc - thisWeek.net_usdc);

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dayOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const weekRange = `${formatDate(weekAgo, dayOpts, timezone)}–${formatDate(now, dayOpts, timezone)}`;

  const lines: string[] = [
    `*Week of ${weekRange}*`,
    ``,
    figuresBlock([
      ['Revenue', signedUsd(thisWeek.revenue_usdc), `${revChange} vs prior week`],
      ['Expenses', signedUsd(-thisWeek.expenses_usdc, '-'), `${expChange} vs prior week`],
      ['Gas', signedUsd(-thisWeek.gas_usdc, '-'), ''],
      ['Net', signedUsd(thisWeek.net_usdc), `${netChange} vs prior week`],
    ]),
  ];

  appendCounterpartiesAndUnknowns(lines, topCounterparties, unknownCount);
  return lines.join('\n');
}
