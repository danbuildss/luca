import { query } from '../db.js';
import { formatAddress } from '../telegram/format.js';
import { walletReadiness, type WalletReadiness } from '../ledger/status.js';

// Telling a new operator where Luca is with a wallet they just added (migration 028):
// once when its books are ready, or once if the first read could not finish. Tied to the
// state the sync, the balance check and classification record (walletReadiness), never to
// a timer. Wallets that were tracked before this existed are marked as told already.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ASSET_ORDER = ['ETH', 'USDC', 'BNKR'];

export function amountWords(asset: string, amount: number): string {
  const digits = asset === 'USDC' ? 2 : amount >= 1000 ? 2 : 4;
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: digits })} ${asset}`;
}

const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const list = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

export const ONLY_BASE = "I only read Base for now, so ETH on Ethereum or other networks isn't counted.";

// Wallets whose books are not ready yet: answers that need complete books wait for them
export async function walletsNotReady(userId: string): Promise<{ all: WalletReadiness[]; waiting: WalletReadiness[] }> {
  const all = await walletReadiness(userId);
  return { all, waiting: all.filter((w) => !w.onboarded && w.state !== 'ready') };
}

export function stillReadingText(waiting: Array<Pick<WalletReadiness, 'address' | 'state'>>): string {
  const names = list(waiting.map((w) => formatAddress(w.address)));
  return waiting.every((w) => w.state === 'failed')
    ? `I couldn't finish reading ${names} yet. I'm trying again and will message you when your books are ready.`
    : `I'm still reading ${names}. I'll message you when your books are ready, then ask me again.`;
}

// This wallet's latest balance of each asset, as read from Base
export async function latestBalances(walletId: string): Promise<Array<{ asset: string; balance: number }>> {
  const rows = (await query<{ asset: string; balance: string }>(
    `SELECT DISTINCT ON (asset) asset, balance::text AS balance
     FROM balance_snapshots WHERE wallet_id = $1 AND asset IN ('ETH', 'USDC', 'BNKR')
     ORDER BY asset, snapshot_at DESC`,
    [walletId],
  )).rows;
  return rows
    .map((r) => ({ asset: r.asset, balance: parseFloat(r.balance) }))
    .sort((a, b) => ASSET_ORDER.indexOf(a.asset) - ASSET_ORDER.indexOf(b.asset));
}

type Activity = { transactions: number; received_usd: number; sent_usd: number; unpriced: number; unplaced: number };

// What moved through the wallet in the last 30 days (supported assets, network fees aside)
async function recentActivity(walletId: string): Promise<Activity> {
  const r = (await query<{ transactions: number; received: string | null; sent: string | null; unpriced: number; unplaced: number }>(
    `SELECT COUNT(DISTINCT ne.hash)::int AS transactions,
            SUM(ne.usd_value) FILTER (WHERE ne.direction = 'in')::text AS received,
            SUM(ne.usd_value) FILTER (WHERE ne.direction = 'out')::text AS sent,
            COUNT(*) FILTER (WHERE ne.usd_value IS NULL AND ne.amount > 0)::int AS unpriced,
            COUNT(*) FILTER (WHERE c.label = 'unknown')::int AS unplaced
     FROM normalized_events ne
     LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.wallet_id = $1 AND ne.supported IS TRUE AND ne.source_key IS DISTINCT FROM 'gas'
       AND ne.block_time >= NOW() - INTERVAL '30 days'`,
    [walletId],
  )).rows[0];
  return {
    transactions: r?.transactions ?? 0,
    received_usd: parseFloat(r?.received ?? '0'),
    sent_usd: parseFloat(r?.sent ?? '0'),
    unpriced: r?.unpriced ?? 0,
    unplaced: r?.unplaced ?? 0,
  };
}

const day = (d: Date): string => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;

// The ready message, in fixed wording from the books
export function readyText(
  w: Pick<WalletReadiness, 'address' | 'ledger_status' | 'incomplete_since_at'>,
  balances: Array<{ asset: string; balance: number }>,
  a: Activity,
): string {
  const name = formatAddress(w.address);
  const held = balances.filter((b) => b.balance > 0);
  const lines: string[] = [];

  if (held.length === 0 && a.transactions === 0) {
    lines.push(`Your books for ${name} are ready. I don't see anything on Base for this wallet in the last 30 days. ${ONLY_BASE}`);
  } else {
    lines.push(`Your books for ${name} are ready.`);
    lines.push(held.length > 0
      ? `On Base: ${list(held.map((b) => amountWords(b.asset, b.balance)))}.`
      : `On Base it holds no ETH, USDC or BNKR right now. ${ONLY_BASE}`);
    if (a.transactions > 0) {
      const money = a.unpriced > 0
        ? ' Some amounts have no price yet, so I have left the dollar totals out.'
        : ` ${usd(a.received_usd)} in, ${usd(a.sent_usd)} out.`;
      lines.push(`Last 30 days: ${a.transactions} ${a.transactions === 1 ? 'transaction' : 'transactions'}.${money}`);
    } else {
      lines.push('No transactions in the last 30 days.');
    }
    if (a.unplaced > 0) {
      lines.push(`${a.unplaced === 1 ? '1 payment' : `${a.unplaced} payments`} I couldn't place; I'll ask you about ${a.unplaced === 1 ? 'it' : 'them'}.`);
    }
  }

  if (w.ledger_status === 'incomplete') {
    lines.push(`I may be missing something${w.incomplete_since_at ? ` since ${day(new Date(w.incomplete_since_at))}` : ''}; I'm fixing it.`);
  } else if (w.ledger_status === 'unknown') {
    lines.push("I couldn't double-check them against Base yet.");
  }
  lines.push('Ask me anything, like "how did this month go?"');
  return lines.join('\n');
}

export function failedText(address: string): string {
  return `I couldn't finish reading ${formatAddress(address)} yet. I'm trying again and will message you when it's done.`;
}

async function queue(userId: string, type: 'wallet_ready' | 'wallet_read_failed', walletId: string, message: string): Promise<boolean> {
  const res = await query(
    `INSERT INTO alerts (user_id, type, message, evidence, dedup_key, certainty)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [userId, type, message, JSON.stringify({ wallet_id: walletId }), `${type}:${walletId}`, type === 'wallet_ready' ? 'verified' : 'data_issue'],
  );
  return res.rowCount === 1;
}

// Once per worker pass, per user: queue the ready or failed message for any wallet whose
// state has reached it. Delivery is the worker's usual alert step.
export async function notifyWalletReadiness(userId: string): Promise<number> {
  let queued = 0;
  for (const w of await walletReadiness(userId)) {
    if (w.ready_notified_at) continue;
    if (w.state === 'ready') {
      const text = readyText(w, await latestBalances(w.wallet_id), await recentActivity(w.wallet_id));
      if (await queue(userId, 'wallet_ready', w.wallet_id, text)) queued++;
      await query(`UPDATE watch_jobs SET ready_notified_at = NOW() WHERE wallet_id = $1 AND user_id = $2`, [w.wallet_id, userId]);
    } else if (w.state === 'failed') {
      if (await queue(userId, 'wallet_read_failed', w.wallet_id, failedText(w.address))) queued++;
    }
  }
  return queued;
}

// What Luca says it already sees, right after tracking starts (null: nothing read yet)
export async function balancesSeenText(walletId: string): Promise<string | null> {
  const balances = await latestBalances(walletId);
  if (balances.length === 0) return null;
  const held = balances.filter((b) => b.balance > 0);
  return held.length > 0
    ? `I can already see ${list(held.map((b) => amountWords(b.asset, b.balance)))}.`
    : `I don't see any ETH, USDC or BNKR on Base in it right now. ${ONLY_BASE}`;
}
