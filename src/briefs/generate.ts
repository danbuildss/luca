import { query } from '../db.js';
import { usdValueSql } from '../ingestion/assets.js';
import { getValuedBalances } from '../books/balances.js';
import { getSpotPrices } from '../ingestion/price.js';
import { stakedPositions } from '../staking/positions.js';
import { namesFor, type Namer } from '../books/names.js';
import { tokenAmount, amountText, usdText, DUST_USD } from '../books/amounts.js';
import { escapeLegacyMarkdown } from '../telegram/format.js';
import { otherOpenUnknowns } from '../alerts/questions.js';
import { dustSql } from '../books/dust.js';
import { askText, type Ask } from '../alerts/ask.js';
import { getLedgerStatus } from '../ledger/status.js';

// The morning message (Oct 4, PR 2): what happened since the last one, in Luca's own fixed
// wording from the books (never the model's), then holdings and why they changed, then the
// transfers Luca could not place, asked once as one numbered list. Nothing at all on a
// morning with nothing to say. On Mondays one message covers the week instead.

const USD = usdValueSql('ne');
const MAX_LINES = 6;
// Network fees under this are not worth a line
const GAS_LINE_MIN_USD = 1;

type Kind =
  | 'staked' | 'unstaked' | 'staking_reward' | 'swap' | 'fees' | 'received' | 'paid'
  | 'refund_in' | 'refund_out' | 'moved' | 'moved_in' | 'unplaced_in' | 'unplaced_out';

type Leg = {
  hash: string;
  direction: 'in' | 'out';
  asset: string | null;
  amount: number;
  usd: number | null;
  from_address: string;
  to_address: string | null;
  label: string | null;
  shape: string | null;
  fee_symbol: string | null;
  gas: boolean;
  dust: boolean;
};

// One line of the story: same kind, same other side, same asset add up
type Item = { kind: Kind; who: string; asset: string | null; amount: number; usd: number | null; count: number; extra?: string };

export type HoldingsAsset = { wallet: number; staked: number; price: number | null };
export type Holdings = { at: string; assets: Record<string, HoldingsAsset> };

// ---------------------------------------------------------------------------
// What moved
// ---------------------------------------------------------------------------

async function legsBetween(userId: string, since: Date, until: Date): Promise<Leg[]> {
  const rows = (await query<{
    hash: string; direction: 'in' | 'out'; asset: string | null; amount: string; usd: string | null;
    from_address: string; to_address: string | null; label: string | null; shape: string | null;
    fee_symbol: string | null; source_key: string | null; dust: boolean;
  }>(
    `SELECT ne.hash, ne.direction, ne.asset, ne.amount::text AS amount, (${USD})::text AS usd,
            ne.from_address, ne.to_address, c.label::text AS label, c.shape, fs.token_symbol AS fee_symbol,
            ne.source_key, ${dustSql('ne')} AS dust
     FROM normalized_events ne
     JOIN wallets w ON w.id = ne.wallet_id AND w.user_id = $1 AND w.active = TRUE
     LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     LEFT JOIN fee_sources fs ON fs.id = c.fee_source_id
     WHERE ne.user_id = $1 AND ne.supported IS TRUE AND ne.amount <> 0
       AND ne.block_time > $2 AND ne.block_time <= $3
     ORDER BY ne.block_time, ne.hash, ne.log_index NULLS FIRST`,
    [userId, since, until],
  )).rows;
  return rows.map((r) => ({
    hash: r.hash,
    direction: r.direction,
    asset: r.asset,
    amount: Math.abs(parseFloat(r.amount)),
    usd: r.usd === null ? null : Math.abs(parseFloat(r.usd)),
    from_address: r.from_address,
    to_address: r.to_address,
    label: r.label,
    shape: r.shape,
    fee_symbol: r.fee_symbol,
    gas: r.source_key === 'gas' || r.label === 'gas',
    dust: r.dust === true,
  }));
}

function kindOf(leg: Leg): Kind {
  const out = leg.direction === 'out';
  switch (leg.label) {
    case 'staked': return 'staked';
    case 'unstaked': return 'unstaked';
    case 'staking_reward': return 'staking_reward';
    case 'revenue': case 'x402_income': return leg.fee_symbol ? 'fees' : out ? 'unplaced_out' : 'received';
    case 'expense': case 'x402_spend': return out ? 'paid' : 'unplaced_in';
    case 'refund': return out ? 'refund_out' : 'refund_in';
    case 'internal_transfer': return 'moved';
    default: return out ? 'unplaced_out' : 'unplaced_in';
  }
}

function addItem(items: Item[], it: Omit<Item, 'count'>): void {
  const same = items.find((x) => x.kind === it.kind && x.who === it.who && x.asset === it.asset && !x.extra && !it.extra);
  if (!same) { items.push({ ...it, count: 1 }); return; }
  same.amount += it.amount;
  same.usd = same.usd === null || it.usd === null ? null : same.usd + it.usd;
  same.count++;
}

const legText = (l: { amount: number; asset: string | null; usd: number | null }): string => amountText(l.amount, l.asset, l.usd);

export function storyItems(legs: Leg[], name: Namer): { items: Item[]; gasUsd: number } {
  const items: Item[] = [];
  let gasUsd = 0;
  const byTx = new Map<string, Leg[]>();
  for (const l of legs) byTx.set(l.hash, [...(byTx.get(l.hash) ?? []), l]);

  for (const [, all] of byTx) {
    for (const g of all.filter((l) => l.gas)) gasUsd += g.usd ?? 0;
    const legsOfTx = all.filter((l) => !l.gas);
    if (legsOfTx.length === 0) continue;

    // A swap is one line: what went out for what came in
    if (legsOfTx.some((l) => l.shape === 'swap' || l.label === 'swap')) {
      const outs = legsOfTx.filter((l) => l.direction === 'out').map((l) => tokenAmount(l.amount, l.asset));
      const ins = legsOfTx.filter((l) => l.direction === 'in').map((l) => tokenAmount(l.amount, l.asset));
      items.push({ kind: 'swap', who: '', asset: null, amount: 0, usd: null, count: 1, extra: `Swapped ${outs.join(' and ') || 'tokens'} for ${ins.join(' and ') || 'tokens'}.` });
      continue;
    }
    // Between the operator's own wallets: one line from the side that sent it
    const internalOut = legsOfTx.some((l) => l.label === 'internal_transfer' && l.direction === 'out');
    for (const l of legsOfTx) {
      if (l.usd !== null && l.usd < DUST_USD) continue;
      let kind = kindOf(l);
      // A few cents from a stranger is not something to tell the operator about
      if (l.dust && kind === 'unplaced_in') continue;
      if (kind === 'moved' && l.direction === 'in') {
        if (internalOut) continue;
        kind = 'moved_in';
      }
      const other = l.direction === 'in' ? l.from_address : l.to_address;
      addItem(items, { kind, who: kind === 'fees' ? (l.fee_symbol ?? '') : name(other, l.direction), asset: l.asset, amount: l.amount, usd: l.usd });
    }
  }
  return { items, gasUsd };
}

function itemLine(it: Item): string {
  if (it.extra) return escapeLegacyMarkdown(it.extra);
  const amt = legText(it);
  const times = it.count > 1 ? ` in ${it.count} transfers` : '';
  const who = escapeLegacyMarkdown(it.who);
  switch (it.kind) {
    case 'staked': return `Staked ${amt}${times}.`;
    case 'unstaked': return `Unstaked ${amt}${times}.`;
    case 'staking_reward': return `Staking reward: ${amt}.`;
    case 'fees': return `${who || 'Creator'} creator fees: ${amt}${it.count > 1 ? ` in ${it.count} claims` : ''}.`;
    case 'received': return `Received ${amt} from ${who}${times}.`;
    case 'paid': return `Paid ${amt} to ${who}${times}.`;
    case 'refund_in': return `Refund of ${amt} from ${who}.`;
    case 'refund_out': return `Refunded ${amt} to ${who}.`;
    case 'moved': return `Moved ${amt} to ${who}${times}.`;
    case 'moved_in': return `Moved ${amt} in from ${who}${times}.`;
    case 'unplaced_in': return `Received ${amt} from ${who}${times}, not placed yet.`;
    case 'unplaced_out': return `Sent ${amt} to ${who}${times}, not placed yet.`;
    default: return `${amt}.`;
  }
}

// ---------------------------------------------------------------------------
// Holdings, and why they changed
// ---------------------------------------------------------------------------

export async function readHoldings(userId: string, now: Date = new Date()): Promise<Holdings | null> {
  const [valued, staked] = await Promise.all([getValuedBalances(userId), stakedPositions(userId)]);
  if (valued.balances.length === 0 && staked.length === 0) return null;
  let prices: Record<string, number | null> = { ...valued.prices };
  if (staked.some((p) => p.asset !== 'USDC' && prices[p.asset] == null)) {
    prices = { ...prices, ...(await getSpotPrices().catch(() => ({}))) };
  }
  const assets: Record<string, HoldingsAsset> = {};
  const slot = (asset: string): HoldingsAsset => {
    assets[asset] ??= { wallet: 0, staked: 0, price: asset === 'USDC' ? 1 : prices[asset] ?? null };
    return assets[asset];
  };
  for (const b of valued.balances) slot(b.asset).wallet += b.balance;
  for (const p of staked) slot(p.asset).staked += p.amount;
  // A price missing for something held: no total, rather than a wrong one
  if (Object.values(assets).some((a) => a.price === null && a.wallet + a.staked > 0)) return null;
  return { at: now.toISOString(), assets };
}

export function holdingsValue(h: Holdings): { total: number; wallet: number; staked: number } {
  let wallet = 0;
  let staked = 0;
  for (const a of Object.values(h.assets)) {
    wallet += a.wallet * (a.price ?? 0);
    staked += a.staked * (a.price ?? 0);
  }
  return { total: wallet + staked, wallet, staked };
}

export type HoldingsChange = {
  delta: number;
  pct: number;
  // Change from prices alone (today's amounts at today's minus yesterday's price), per asset
  price: Array<{ asset: string; usd: number; pct: number }>;
  // Change from amounts moving in or out (valued at yesterday's prices)
  moved: number;
};

// Exact split: delta = Σ q1·(p1 − p0) + Σ (q1 − q0)·p0
export function holdingsChange(prev: Holdings, now: Holdings): HoldingsChange | null {
  const before = holdingsValue(prev).total;
  const after = holdingsValue(now).total;
  const price: HoldingsChange['price'] = [];
  let moved = 0;
  for (const asset of new Set([...Object.keys(prev.assets), ...Object.keys(now.assets)])) {
    const p0 = prev.assets[asset]?.price ?? null;
    const p1 = now.assets[asset]?.price ?? null;
    const q0 = (prev.assets[asset]?.wallet ?? 0) + (prev.assets[asset]?.staked ?? 0);
    const q1 = (now.assets[asset]?.wallet ?? 0) + (now.assets[asset]?.staked ?? 0);
    if ((q0 > 0 && p0 === null) || (q1 > 0 && (p1 === null || p0 === null))) return null;
    if (p0 !== null && p1 !== null && q1 > 0 && p1 !== p0) price.push({ asset, usd: q1 * (p1 - p0), pct: p1 / p0 - 1 });
    moved += (q1 - q0) * (p0 ?? p1 ?? 0);
  }
  return { delta: after - before, pct: before > 0 ? (after - before) / before : 0, price, moved };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayIn(timezone: string): (d: Date) => string {
  return (d: Date) => {
    try {
      const p = new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric', timeZone: timezone }).formatToParts(d);
      return `${MONTHS[Number(p.find((x) => x.type === 'month')?.value) - 1]} ${p.find((x) => x.type === 'day')?.value}`;
    } catch {
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    }
  };
}

export function holdingsLine(now: Holdings, prev: Holdings | null, since: string): string {
  const v = holdingsValue(now);
  const split = v.staked <= 0 ? '' : v.wallet < DUST_USD ? ' (all staked)' : ` (${usdText(v.wallet)} in your wallets, ${usdText(v.staked)} staked)`;
  const base = `Holdings: ${usdText(v.total)}${split}`;
  const change = prev ? holdingsChange(prev, now) : null;
  // Small changes are not news
  if (!change || Math.abs(change.delta) < 5 || Math.abs(change.pct) < 0.02) return `${base}.`;
  const dir = change.delta > 0 ? 'up' : 'down';
  const priceTotal = change.price.reduce((t, p) => t + p.usd, 0);
  let why: string;
  if (Math.abs(priceTotal) >= Math.abs(change.moved)) {
    const top = [...change.price].sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd))[0];
    why = top ? `mostly ${top.asset}'s price (${top.pct >= 0 ? 'up' : 'down'} ${Math.round(Math.abs(top.pct) * 100)}%)` : 'from prices';
  } else {
    why = change.moved < 0 ? `mostly ${usdText(-change.moved)} that went out` : `mostly ${usdText(change.moved)} that came in`;
  }
  return `${base}, ${dir} ${usdText(Math.abs(change.delta))} since ${since}, ${why}.`;
}

// ---------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------

export type Morning = {
  text: string | null;          // null: nothing to say
  holdings: Holdings | null;    // stored with the brief, for the next morning
  asked: Ask[];                 // the transfers asked about, in the order numbered
};

type Opts = {
  timezone: string;
  since: Date;
  now?: Date;
  prev?: Holdings | null;
  asks?: Ask[];                 // due questions, biggest first (at most 3)
  weekly?: boolean;
};

function sinceWords(since: Date, now: Date, day: (d: Date) => string): string {
  const hours = (now.getTime() - since.getTime()) / 3_600_000;
  return hours <= 30 ? 'yesterday' : day(since);
}

export async function buildMorning(userId: string, opts: Opts): Promise<Morning> {
  const now = opts.now ?? new Date();
  const day = dayIn(opts.timezone);
  const [legs, name, holdings, ledger] = await Promise.all([
    legsBetween(userId, opts.since, now), namesFor(userId), readHoldings(userId, now), getLedgerStatus(userId),
  ]);
  // Books not proven against the chain: said whenever a message goes out, never alone
  const ledgerLine = ledger.status === 'incomplete'
    ? 'Your books may be missing a transfer: a balance changed in a way I cannot explain yet. I am working on it.'
    : null;
  const asks = opts.asks ?? [];
  const prevSince = opts.prev ? sinceWords(new Date(opts.prev.at), now, day) : '';
  const hLine = holdings ? holdingsLine(holdings, opts.prev ?? null, prevSince) : null;
  const questions = asks.length > 0 ? ['', askText(asks, name, day)] : [];

  if (opts.weekly) {
    const text = weeklyText(legs, name, hLine, questions, await restLine(userId, asks.map((q) => q.id)));
    return { text: ledgerLine ? `${text}\n\n${ledgerLine}` : text, holdings, asked: asks };
  }

  const story = storyItems(legs, name);
  const gasUsd = story.gasUsd;
  // A transfer asked about below is not told twice in the same message
  const asked = new Set(asks.map((q) => `${q.direction === 'in' ? 'unplaced_in' : 'unplaced_out'}|${name(q.counterparty_address, q.direction)}`));
  const items = story.items.filter((i) => !asked.has(`${i.kind}|${i.who}`));
  if (items.length === 0 && asks.length === 0) return { text: null, holdings, asked: [] };

  const lines: string[] = [];
  if (items.length > 0) {
    const hours = (now.getTime() - opts.since.getTime()) / 3_600_000;
    lines.push(hours <= 30 ? 'Good morning. Since yesterday morning:' : `Good morning. Since ${day(opts.since)}:`);
    const shown = items.slice(0, MAX_LINES);
    for (const it of shown) lines.push(`- ${itemLine(it)}`);
    const stakedNow = await stakedSummary(userId, items);
    if (stakedNow) lines.push(`- ${stakedNow}`);
    if (items.length > MAX_LINES) lines.push(`- …and ${items.length - MAX_LINES} more. Ask me "what happened yesterday?"`);
    else if (gasUsd >= GAS_LINE_MIN_USD) lines.push(`- Network fees: ${usdText(gasUsd)}.`);
    if (hLine) lines.push('', hLine);
  } else {
    lines.push('Good morning.');
  }
  if (ledgerLine) lines.push('', ledgerLine);
  lines.push(...questions);
  return { text: lines.join('\n'), holdings, asked: asks };
}

// After a stake or unstake: what is staked now, as the contract reported it
async function stakedSummary(userId: string, items: Item[]): Promise<string | null> {
  if (!items.some((i) => i.kind === 'staked' || i.kind === 'unstaked')) return null;
  const totals = new Map<string, number>();
  for (const p of await stakedPositions(userId)) totals.set(p.asset, (totals.get(p.asset) ?? 0) + p.amount);
  if (totals.size === 0) return 'You have nothing staked now.';
  return `You now have ${[...totals].map(([a, n]) => tokenAmount(n, a)).join(' and ')} staked.`;
}

// Everything still open beyond the list just shown, in one line
async function restLine(userId: string, listed: string[]): Promise<string | null> {
  const rest = await otherOpenUnknowns(userId, listed);
  if (rest.count === 0) return null;
  const one = rest.count === 1;
  const lead = listed.length > 0 ? `Plus ${rest.count} smaller ${one ? 'one' : 'ones'}` : `${rest.count} small ${one ? 'transfer' : 'transfers'} still open`;
  return `${lead} (${usdText(rest.usd)} in total). Tell me if you want to go through ${one ? 'it' : 'them'}.`;
}

function weeklyText(legs: Leg[], name: Namer, hLine: string | null, questions: string[], small: string | null): string {
  const { items, gasUsd } = storyItems(legs, name);
  if (items.length === 0) {
    return [`Good morning. Quiet week: nothing moved in your wallets.${hLine ? ` ${hLine}` : ''}`, ...questions, ...(small ? ['', small] : [])].join('\n');
  }
  const sum = (kinds: Kind[]) => items.filter((i) => kinds.includes(i.kind));
  const usdOf = (xs: Item[]) => xs.reduce((t, i) => t + (i.usd ?? 0), 0);
  const top = (xs: Item[]) => {
    const by = new Map<string, number>();
    for (const i of xs) by.set(i.kind === 'fees' ? `${i.who} creator fees` : i.who, (by.get(i.kind === 'fees' ? `${i.who} creator fees` : i.who) ?? 0) + (i.usd ?? 0));
    return [...by].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w, u]) => `${escapeLegacyMarkdown(w)} ${usdText(u)}`).join(', ');
  };

  const lines = ['Good morning. Your week:'];
  const revenue = sum(['received', 'fees', 'staking_reward', 'refund_in']);
  if (revenue.length > 0) lines.push(`- Came in: ${usdText(usdOf(revenue))} (${top(revenue)}).`);
  const paid = sum(['paid', 'refund_out']);
  if (paid.length > 0) lines.push(`- Paid out: ${usdText(usdOf(paid))} (${top(paid)}).`);
  for (const k of ['staked', 'unstaked'] as const) {
    const xs = sum([k]);
    const byAsset = new Map<string, number>();
    for (const i of xs) byAsset.set(i.asset ?? '', (byAsset.get(i.asset ?? '') ?? 0) + i.amount);
    if (xs.length > 0) lines.push(`- ${k === 'staked' ? 'Staked' : 'Unstaked'} ${[...byAsset].map(([a, n]) => tokenAmount(n, a)).join(' and ')}.`);
  }
  const swaps = sum(['swap']).length;
  if (swaps > 0) lines.push(`- ${swaps} ${swaps === 1 ? 'swap' : 'swaps'}.`);
  const moved = sum(['moved']);
  if (moved.length > 0) lines.push(`- Moved ${usdText(usdOf(moved))} between your wallets.`);
  if (gasUsd >= GAS_LINE_MIN_USD) lines.push(`- Network fees: ${usdText(gasUsd)}.`);
  if (hLine) lines.push('', hLine);
  lines.push(...questions);
  if (small) lines.push('', small);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// On request (/brief): the same message, without asking anything
// ---------------------------------------------------------------------------

export async function generateDailyBrief(userId: string, timezone = 'UTC'): Promise<string> {
  const now = new Date();
  const m = await buildMorning(userId, { timezone, since: new Date(now.getTime() - 24 * 3_600_000), now });
  if (m.text) return m.text;
  const v = m.holdings ? holdingsValue(m.holdings) : null;
  return `Nothing moved in your wallets in the last 24 hours.${v ? ` Holdings: ${usdText(v.total)}.` : ''}`;
}

export async function generateWeeklyBrief(userId: string, timezone = 'UTC'): Promise<string> {
  const now = new Date();
  const m = await buildMorning(userId, { timezone, since: new Date(now.getTime() - 7 * 24 * 3_600_000), now, weekly: true });
  return m.text ?? 'Quiet week: nothing moved in your wallets.';
}
