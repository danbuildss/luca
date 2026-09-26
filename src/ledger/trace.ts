import { query } from '../db.js';
import {
  getTransactionReceipt, getTransaction, getLogsChunked, fetchAllTransfers, blockToHex,
  TRANSFER_TOPIC, type AlchemyTransfer,
} from '../ingestion/alchemy.js';
import { parseUniqueId, buildSourceKey } from '../ingestion/normalize.js';
import { BASE_USDC, BASE_BNKR, SUPPORTED_TOKENS, usdValueSql } from '../ingestion/assets.js';
import { REVENUE_SQL, EXPENSES_SQL, GAS_SQL } from '../books/query.js';
import { BRIEF_CATEGORIES } from '../types/index.js';

// Follows one transaction through every layer Luca keeps, for every tracked wallet it
// touches: chain → transfer feed → raw evidence → normalized event → asset identity →
// classification → price → books → answers. Names the first layer that lost a movement,
// so a missing transaction points at exactly one place. Read-only.

export const TRACE_LAYERS = ['chain', 'provider', 'raw', 'normalized', 'identity', 'classification', 'price'] as const;
export type TraceLayer = (typeof TRACE_LAYERS)[number];

export type TraceMovement = {
  wallet: string;
  wallet_id: string | null;
  owner: string | null;
  wallet_active: boolean | null;
  source_key: string; // log:N | external | internal:… | gas
  asset: string | null;
  direction: 'in' | 'out' | null;
  raw_amount: string | null;
  // true / false per layer; null where the layer does not apply or could not be checked
  chain: boolean | null;
  provider: boolean | null;
  provider_name: string | null; // who delivered the raw record: alchemy | blockscout | logs
  raw: boolean;
  normalized: boolean;
  supported: boolean | null;
  label: string | null;
  label_status: string | null; // confirmed | provisional | unknown
  method: string | null;
  usd_value: number | null;
  // How the books count it: revenue / expenses / gas with the signed USD amount, or
  // outside P&L (internal, swap, unknown)
  books: { figure: 'revenue' | 'expenses' | 'gas' | 'internal' | 'swap' | 'unknown'; usd: number | null } | null;
  lost_at: TraceLayer | null;
  notes: string[];
};

export type TraceResult = {
  hash: string;
  checked_chain: boolean;
  found_on_chain: boolean | null;
  status: 'success' | 'failed' | null;
  block: number | null;
  movements: TraceMovement[];
  answers: number;
  // complete: every movement reached the books; gaps: at least one movement was lost;
  // not_tracked: on chain but touches no tracked wallet; not_found: unknown hash
  verdict: 'complete' | 'gaps' | 'not_tracked' | 'not_found';
};

type TrackedWallet = { id: string; address: string; active: boolean; owner: string | null; user_id: string };

type EventRow = {
  id: string;
  wallet_id: string;
  source_key: string;
  asset: string | null;
  direction: 'in' | 'out';
  raw_amount: string | null;
  supported: boolean | null;
  token_address: string | null;
  usd: string | null;
  label: string | null;
  label_status: string | null;
  method: string | null;
  revenue: string | null;
  expenses: string | null;
  gas: string | null;
};

const lower = (s: string | null | undefined): string => (s ?? '').toLowerCase();
const topicAddress = (topic: string): string => '0x' + topic.slice(-40).toLowerCase();
const num = (v: string | null): number | null => (v === null ? null : parseFloat(v));

function figureOf(label: string | null): NonNullable<TraceMovement['books']>['figure'] | null {
  if (!label) return null;
  if ((BRIEF_CATEGORIES.revenue as string[]).includes(label)) return 'revenue';
  if ((BRIEF_CATEGORIES.expenses as string[]).includes(label)) return 'expenses';
  if ((BRIEF_CATEGORIES.gas as string[]).includes(label)) return 'gas';
  if ((BRIEF_CATEGORIES.internal as string[]).includes(label)) return 'internal';
  if ((BRIEF_CATEGORIES.conversion as string[]).includes(label)) return 'swap';
  if (label === 'refund') return null; // decided by direction below
  return 'unknown';
}

async function trackedWallets(addresses: string[], walletIds: string[]): Promise<TrackedWallet[]> {
  if (addresses.length === 0 && walletIds.length === 0) return [];
  const res = await query<TrackedWallet>(
    `SELECT w.id, LOWER(w.address) AS address, w.active, u.telegram_username AS owner, w.user_id
     FROM wallets w JOIN users u ON u.id = w.user_id
     WHERE w.chain = 'base' AND (LOWER(w.address) = ANY($1::text[]) OR w.id = ANY($2::uuid[]))`,
    [addresses, walletIds],
  );
  return res.rows;
}

export async function traceTransaction(hash: string, apiKey?: string): Promise<TraceResult> {
  const h = hash.trim().toLowerCase();

  // Everything Luca stored for this hash
  const [rawTransfers, rawReceipts, events] = await Promise.all([
    query<{ wallet_id: string; source_key: string; provider: string }>(
      `SELECT wallet_id, source_key, provider FROM raw_transfers WHERE chain = 'base' AND LOWER(tx_hash) = $1`, [h],
    ),
    query<{ wallet_id: string; status: string }>(
      `SELECT wallet_id, status FROM raw_receipts WHERE chain = 'base' AND LOWER(tx_hash) = $1`, [h],
    ),
    query<EventRow>(
      `SELECT ne.id, ne.wallet_id, ne.source_key, ne.asset, ne.direction, ne.raw_amount::text, ne.supported,
              ne.token_address, (${usdValueSql('ne')})::text AS usd,
              c.label::text AS label, c.status AS label_status, c.method::text AS method,
              (${REVENUE_SQL})::text AS revenue, (${EXPENSES_SQL})::text AS expenses, (${GAS_SQL})::text AS gas
       FROM normalized_events ne
       LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.chain = 'base' AND LOWER(ne.hash) = $1`,
      [h],
    ),
  ]);

  // What the chain says, when it can be asked
  let checkedChain = false;
  let found: boolean | null = null;
  let status: TraceResult['status'] = null;
  let block: number | null = null;
  const chainMoves: Array<{ address: string; source_key: string; asset: string; direction: 'in' | 'out'; raw: bigint }> = [];
  const chainAddresses = new Set<string>();

  if (apiKey) {
    checkedChain = true;
    const [receipt, tx] = await Promise.all([getTransactionReceipt(apiKey, h), getTransaction(apiKey, h)]);
    found = Boolean(receipt);
    if (receipt) {
      status = receipt.status;
      block = receipt.blockNumber;
      chainAddresses.add(lower(receipt.from));
      if (receipt.to) chainAddresses.add(lower(receipt.to));
      if (receipt.fee > 0n) {
        chainMoves.push({ address: lower(receipt.from), source_key: 'gas', asset: 'ETH', direction: 'out', raw: receipt.fee });
      }
      // A failed transaction moves nothing but its fee
      if (receipt.status === 'success') {
        if (tx && tx.value > 0n && tx.to) {
          chainMoves.push({ address: lower(tx.from), source_key: 'external', asset: 'ETH', direction: 'out', raw: tx.value });
          chainMoves.push({ address: lower(tx.to), source_key: 'external', asset: 'ETH', direction: 'in', raw: tx.value });
        }
        const logs = await getLogsChunked(apiKey, { address: [BASE_USDC, BASE_BNKR], topics: [TRANSFER_TOPIC] }, block, block);
        for (const l of logs) {
          if (lower(l.transactionHash) !== h || l.topics.length !== 3) continue;
          const raw = l.data && l.data !== '0x' ? BigInt(l.data) : 0n;
          if (raw === 0n) continue; // moves nothing (usually address-poisoning spam)
          const asset = SUPPORTED_TOKENS[lower(l.address)]?.symbol ?? 'unknown';
          const key = `log:${parseInt(l.logIndex, 16)}`;
          const from = topicAddress(l.topics[1]);
          const to = topicAddress(l.topics[2]);
          chainAddresses.add(from).add(to);
          chainMoves.push({ address: from, source_key: key, asset, direction: 'out', raw });
          chainMoves.push({ address: to, source_key: key, asset, direction: 'in', raw });
        }
      }
    }
  }

  const walletIds = [...new Set([...rawTransfers.rows, ...rawReceipts.rows, ...events.rows].map((r) => r.wallet_id))];
  const wallets = await trackedWallets([...chainAddresses], walletIds);
  const byAddress = new Map(wallets.map((w) => [w.address, w]));
  const byId = new Map(wallets.map((w) => [w.id, w]));

  // What Alchemy's transfer feed reports for each tracked wallet in that block
  const feed = new Map<string, AlchemyTransfer[]>();
  if (apiKey && block !== null) {
    for (const w of wallets) {
      const all = await fetchAllTransfers(apiKey, w.address, blockToHex(block), blockToHex(block));
      feed.set(w.id, all.filter((t) => lower(t.hash) === h));
    }
  }
  const feedKey = (t: AlchemyTransfer, w: TrackedWallet): { key: string; direction: 'in' | 'out' } => {
    const parsed = parseUniqueId(t.uniqueId);
    const kind = t.category === 'external' ? 'external' : t.category === 'internal' ? 'internal' : parsed.kind;
    const key = buildSourceKey({
      kind,
      logIndex: t.category === 'erc20' ? parsed.index : null,
      internalIndex: t.category === 'internal' ? parsed.index : null,
      from: t.from, to: t.to, rawValue: t.rawContract.value, uniqueId: t.uniqueId,
    });
    return { key, direction: lower(t.from) === w.address ? 'out' : 'in' };
  };

  // One movement per (wallet, source_key); a self-transfer is one movement per direction
  const movements = new Map<string, TraceMovement>();
  const get = (w: TrackedWallet | undefined, address: string, key: string, direction: 'in' | 'out' | null): TraceMovement => {
    const id = `${w?.id ?? address}|${key}|${direction ?? ''}`;
    let m = movements.get(id);
    if (!m) {
      m = {
        wallet: w?.address ?? address, wallet_id: w?.id ?? null, owner: w?.owner ?? null, wallet_active: w?.active ?? null,
        source_key: key, asset: null, direction, raw_amount: null,
        chain: checkedChain ? false : null, provider: null, provider_name: null, raw: false, normalized: false,
        supported: null, label: null, label_status: null, method: null, usd_value: null, books: null,
        lost_at: null, notes: [],
      };
      movements.set(id, m);
    }
    return m;
  };

  for (const c of chainMoves) {
    const w = byAddress.get(c.address);
    if (!w) continue; // not one of Luca's wallets
    const m = get(w, c.address, c.source_key, c.direction);
    m.chain = true;
    m.asset = c.asset;
    m.raw_amount = c.raw.toString();
  }

  for (const w of wallets) {
    for (const t of feed.get(w.id) ?? []) {
      const { key, direction } = feedKey(t, w);
      const m = get(w, w.address, key, direction);
      m.provider = true;
      m.asset ??= t.category === 'erc20' ? (SUPPORTED_TOKENS[lower(t.rawContract.address)]?.symbol ?? t.asset) : 'ETH';
      // ETH a contract sent inside the transaction: not visible without an execution trace
      if (t.category === 'internal' && m.chain === false) m.chain = null;
    }
  }

  // Gas has no transfer-feed entry; the raw layer is the stored receipt
  for (const r of rawReceipts.rows) {
    const w = byId.get(r.wallet_id);
    const m = get(w, w?.address ?? r.wallet_id, 'gas', 'out');
    m.raw = true;
  }
  for (const r of rawTransfers.rows) {
    const w = byId.get(r.wallet_id);
    const matches = [...movements.values()].filter((m) => m.wallet_id === r.wallet_id && m.source_key === r.source_key);
    const targets = matches.length > 0 ? matches : [get(w, w?.address ?? r.wallet_id, r.source_key, null)];
    for (const m of targets) { m.raw = true; m.provider_name = r.provider; }
  }
  for (const e of events.rows) {
    const w = byId.get(e.wallet_id);
    const matches = [...movements.values()].filter((m) =>
      m.wallet_id === e.wallet_id && m.source_key === e.source_key && (m.direction === null || m.direction === e.direction));
    const m = matches[0] ?? get(w, w?.address ?? e.wallet_id, e.source_key, e.direction);
    m.direction = e.direction;
    m.normalized = true;
    m.asset ??= e.asset;
    m.raw_amount ??= e.raw_amount;
    m.supported = e.supported;
    m.label = e.label;
    m.label_status = e.label_status;
    m.method = e.method;
    m.usd_value = num(e.usd);
    const figure = figureOf(e.label)
      ?? (e.label === 'refund' ? (e.direction === 'out' ? 'revenue' : 'expenses') : null);
    if (figure) {
      const usd = figure === 'revenue' ? num(e.revenue) : figure === 'expenses' ? num(e.expenses) : figure === 'gas' ? num(e.gas) : null;
      m.books = { figure, usd };
    }
  }

  // Where each movement stopped
  for (const m of movements.values()) {
    const isGas = m.source_key === 'gas';
    // ETH a contract sent inside a transaction is only visible through the transfer feed
    if (m.source_key.startsWith('internal') && m.chain === false) m.chain = null;
    const expected = m.chain !== false; // on chain, or not checkable (no key, internal ETH)
    const trackedAsset = m.asset === 'ETH' || m.asset === 'USDC' || m.asset === 'BNKR';
    if (!isGas && m.provider === null && checkedChain && block !== null && m.wallet_id) m.provider = false;
    if (m.provider === false && m.provider_name === 'logs') m.notes.push('missed by the transfer feed, caught by the token-log cross-check');
    if (m.provider === false && m.raw && m.provider_name === 'blockscout') m.notes.push('delivered by the Blockscout fallback');
    if (m.wallet_active === false) m.notes.push('wallet is deactivated');

    if (!expected) {
      if (m.normalized && m.supported !== false) {
        m.notes.push(status === 'failed'
          ? 'recorded as a transfer, but the transaction failed and moved nothing'
          : 'recorded, but not found on chain');
        m.lost_at = 'chain';
      }
      continue;
    }
    if (!trackedAsset && m.chain === true) continue; // not an asset Luca books
    if (!m.raw && !m.normalized) { m.lost_at = m.provider === false ? 'provider' : 'raw'; continue; }
    // Rows stored before raw evidence was kept (migration 016) have no raw record
    if (!m.raw) m.notes.push('no raw record (stored before raw evidence was kept)');
    if (!m.normalized) { m.lost_at = 'normalized'; continue; }
    if (m.supported === false) { m.lost_at = 'identity'; continue; }
    if (!m.label) { m.lost_at = 'classification'; m.notes.push('not classified yet'); continue; }
    if (m.label_status === 'unknown') m.notes.push('waiting for the operator to say what it was');
    if (m.label_status === 'provisional') m.notes.push('labeled by the AI, not confirmed');
    if (m.books && ['revenue', 'expenses', 'gas'].includes(m.books.figure) && m.books.usd === null) {
      m.lost_at = 'price';
      m.notes.push('no USD price yet, so it is not in the totals');
    }
  }

  // Answers that quoted this transaction (full hash or the short 0x1234…abcd form)
  const userIds = [...new Set(wallets.map((w) => w.user_id))];
  const answers = userIds.length === 0 ? 0 : (await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM answer_traces
     WHERE user_id = ANY($1::uuid[]) AND (LOWER(answer) LIKE $2 OR LOWER(answer) LIKE $3)`,
    [userIds, `%${h}%`, `%${h.slice(0, 6)}…${h.slice(-4)}%`],
  )).rows[0]?.n ?? 0;

  const list = [...movements.values()]
    .filter((m) => m.wallet_id !== null || m.normalized || m.raw)
    .sort((a, b) => a.wallet.localeCompare(b.wallet) || a.source_key.localeCompare(b.source_key));
  const nothingStored = rawTransfers.rows.length + rawReceipts.rows.length + events.rows.length === 0;
  const verdict: TraceResult['verdict'] =
    found === false && nothingStored ? 'not_found'
      : list.length === 0 ? (found ? 'not_tracked' : 'not_found')
        : list.some((m) => m.lost_at !== null) ? 'gaps' : 'complete';

  return { hash: h, checked_chain: checkedChain, found_on_chain: found, status, block, movements: list, answers, verdict };
}

// A few lines for Telegram or a terminal, in plain words
export function describeTrace(t: TraceResult): string[] {
  const short = `${t.hash.slice(0, 6)}…${t.hash.slice(-4)}`;
  const head = t.verdict === 'not_found'
    ? `${short}: not found on Base and nothing stored for it.`
    : t.verdict === 'not_tracked'
      ? `${short}: on Base (block ${t.block}), but it touches none of Luca's wallets.`
      : t.verdict === 'complete'
        ? `${short}: complete. Every movement reached the books.`
        : `${short}: gaps found.`;
  const lines = [head];
  if (t.status === 'failed') lines.push('The transaction failed on chain, so only its fee moved.');
  if (!t.checked_chain) lines.push('Chain not checked (no Alchemy key); stored layers only.');
  for (const m of t.movements) {
    const who = m.owner ? `@${m.owner} ` : '';
    const amount = m.asset ?? '?';
    const where = m.lost_at ? `LOST at ${m.lost_at}` : m.books ? `in books as ${m.books.figure}${m.books.usd !== null ? ` ($${m.books.usd.toFixed(2)})` : ''}` : 'stored';
    const extra = m.notes.length > 0 ? ` (${m.notes.join('; ')})` : '';
    lines.push(`- ${who}${m.wallet.slice(0, 6)}…${m.wallet.slice(-4)} ${m.source_key} ${amount} ${m.direction ?? ''}: ${where}${extra}`);
  }
  if (t.answers > 0) lines.push(`Quoted in ${t.answers} answer${t.answers === 1 ? '' : 's'}.`);
  return lines;
}
