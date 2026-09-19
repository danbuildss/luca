import { query } from '../db.js';
import { getPnlSummary } from '../books/query.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function pct(current: number, prior: number): string {
  if (prior === 0) return current > 0 ? '+∞%' : '—';
  const change = ((current - prior) / prior) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(0)}%`;
}

function usd(amount: number): string {
  return `$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
       SUM(COALESCE(ne.usd_value, CASE WHEN ne.asset = 'USDC' THEN ne.amount ELSE 0 END))::text AS total_usdc
     FROM classifications c
     JOIN normalized_events ne ON ne.id = c.event_id
     LEFT JOIN counterparty_rules cr
       ON cr.user_id = ne.user_id
       AND cr.address = LOWER(CASE WHEN ne.direction = 'in' THEN ne.from_address ELSE ne.to_address END)
     WHERE ne.user_id = $1
       AND c.superseded_at IS NULL
       AND c.label IN ('revenue', 'expense', 'x402_income', 'x402_spend')
       AND ne.block_time >= NOW() - INTERVAL '1 day' * $2
     GROUP BY address, cr.name
     ORDER BY SUM(COALESCE(ne.usd_value, CASE WHEN ne.asset = 'USDC' THEN ne.amount ELSE 0 END)) DESC
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
       AND c.superseded_at IS NULL
       AND c.label = 'unknown'
       AND ne.block_time >= NOW() - INTERVAL '1 day' * $2`,
    [userId, periodDays],
  );
  return parseInt(res.rows[0]?.cnt ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Daily brief
// ---------------------------------------------------------------------------

export async function generateDailyBrief(userId: string): Promise<string> {
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

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });

  const lines: string[] = [
    `📅 *Daily brief — ${dateStr}*`,
    ``,
    `💰 Revenue      +${usd(today.revenue_usdc)}`,
    `💸 Expenses     −${usd(today.expenses_usdc)}`,
    `⛽ Gas          −${usd(today.gas_usdc)}`,
    `─────────────────────`,
    `📈 Net          ${today.net_usdc >= 0 ? '+' : ''}${usd(today.net_usdc)}`,
    ``,
    `📊 vs yesterday  ${revChange} revenue  •  ${expChange} expenses`,
  ];

  if (topCounterparties.length > 0) {
    lines.push(``, `🔝 Top counterparties`);
    for (const cp of topCounterparties) {
      const label = cp.name ?? `${cp.address.slice(0, 6)}…${cp.address.slice(-4)}`;
      lines.push(`  ${label.slice(0, 20).padEnd(20)} ${usd(parseFloat(cp.total_usdc))}`);
    }
  }

  if (unknownCount > 0) {
    lines.push(``, `❓ ${unknownCount} unknown${unknownCount > 1 ? 's' : ''} — /review to label`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Weekly brief
// ---------------------------------------------------------------------------

export async function generateWeeklyBrief(userId: string): Promise<string> {
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
  const weekRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  const lines: string[] = [
    `📅 *Week of ${weekRange}*`,
    ``,
    `💰 Revenue      +${usd(thisWeek.revenue_usdc)}  (${revChange} vs prior week)`,
    `💸 Expenses     −${usd(thisWeek.expenses_usdc)}  (${expChange} vs prior week)`,
    `⛽ Gas          −${usd(thisWeek.gas_usdc)}`,
    `─────────────────────`,
    `📈 Net          ${thisWeek.net_usdc >= 0 ? '+' : ''}${usd(thisWeek.net_usdc)}  (${netChange} vs prior week)`,
  ];

  if (topCounterparties.length > 0) {
    lines.push(``, `🔝 Top counterparties`);
    for (const cp of topCounterparties) {
      const label = cp.name ?? `${cp.address.slice(0, 6)}…${cp.address.slice(-4)}`;
      lines.push(`  ${label.slice(0, 20).padEnd(20)} ${usd(parseFloat(cp.total_usdc))}`);
    }
  }

  if (unknownCount > 0) {
    lines.push(``, `❓ ${unknownCount} unknown${unknownCount > 1 ? 's' : ''} — /review to label`);
  }

  return lines.join('\n');
}
