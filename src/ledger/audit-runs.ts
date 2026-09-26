import { query } from '../db.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getBlock } from '../ingestion/alchemy.js';
import { SUPPORTED_TOKENS } from '../ingestion/assets.js';
import { significant } from '../books/breakdown.js';
import {
  auditRange, auditableRange, safeBlock, ProviderUnavailableError, type AuditItem, type WalletAudit,
} from './audit.js';
import type { TraceLayer } from './trace.js';

// "Are my books complete?" from chat. A check compares everything the chain and the data
// providers know for an operator's wallets with what reached the books (src/ledger/audit.ts),
// up to the safe chain block. It runs in the background and is recorded in audit_runs, so
// a restart mid-check is known and retried, and the outcome is sent to whoever asked
// exactly once. Read-only: a check never changes books.
//
// A result records, per wallet, the block it verified through and a fingerprint of the
// books over that range. It is reused only when the chain has no new safe blocks and the
// fingerprint is unchanged. New blocks are verified before anything is said about them
// (only the new range, when the earlier result still holds), so a transaction Luca failed
// to ingest can never hide behind "nothing changed in the database".

// Where a movement stopped, in the operator's terms
export const GAP_KINDS = [
  'not_synced', 'missing_from_provider', 'provider_not_stored', 'stored_not_normalized', 'unsupported', 'not_on_chain',
  'unclassified', 'missing_price',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

const GAP_OF_LAYER: Record<TraceLayer, GapKind> = {
  provider: 'missing_from_provider',
  raw: 'provider_not_stored',
  normalized: 'stored_not_normalized',
  identity: 'unsupported',
  chain: 'not_on_chain',
  classification: 'unclassified',
  price: 'missing_price',
};

// Missing = not in the books at all (or in them wrongly); incomplete = in the books but
// not finished (no label yet, or no USD price)
const MISSING: GapKind[] = ['not_synced', 'missing_from_provider', 'provider_not_stored', 'stored_not_normalized', 'unsupported', 'not_on_chain'];

const GAP_WORDS: Record<GapKind, string> = {
  not_synced: "I haven't synced it yet, so it's missing from your books",
  missing_from_provider: "my data provider never delivered it, so it's missing from your books",
  provider_not_stored: "my data provider reported it, but I never stored it, so it's missing from your books",
  stored_not_normalized: 'I have the raw record, but it never became an entry in your books',
  unsupported: "I recorded it as an untracked token, so it's not in your books",
  not_on_chain: "it's in your books, but the chain shows it never happened (the transaction failed)",
  unclassified: "it's in your books but not labeled yet",
  missing_price: "it's in your books but has no USD price yet, so it's not in your totals",
};

export type AuditEntry = AuditItem & { wallet: string; time: string | null };

export type AuditSummary = {
  checked_at: string;
  days: number | null;
  wallets: Array<{
    wallet_id: string; address: string; from_block: number; to_block: number;
    from_time: string | null; to_time: string | null;
    synced_to: number | null; synced_to_time: string | null;
    // Fingerprint of the books over [from_block, to_block] when verified; null when the
    // books changed while the check ran (the result is then never reused)
    signature: string | null;
  }>;
  transactions: number;
  movements: number;
  gaps: Record<GapKind, AuditEntry[]>;
  unknown: AuditEntry[];
};

// How many checks an operator's own questions start per day before recent results are
// reused regardless (admins are not limited). Never surfaced as a limit.
const OPERATOR_RUNS_PER_DAY = 6;
// A result for unchanged books is reused for this long
const REUSE_HOURS = 24;
// A run interrupted by restarts this many times is reported instead of retried
const MAX_ATTEMPTS = 2;

type Notifier = (requesterId: string, text: string) => Promise<void>;
let notify: Notifier | null = null;

// Called once by the Telegram bot: how a finished check reaches the person who asked
export function setAuditNotifier(fn: Notifier): void {
  notify = fn;
}

// ---------------------------------------------------------------------------
// State of the books, to tell whether an earlier result still holds
// ---------------------------------------------------------------------------

async function activeWallets(userId: string): Promise<Array<{ id: string; address: string }>> {
  const res = await query<{ id: string; address: string }>(
    `SELECT id, LOWER(address) AS address FROM wallets
     WHERE user_id = $1 AND active = TRUE AND chain = 'base' ORDER BY created_at`,
    [userId],
  );
  return res.rows;
}

// Fingerprint of everything a check's outcome depends on for one wallet, up to a block:
// each stored event's identity, amount, USD value and price source, its active label and
// status, the raw transfer records and the fees. Any added row or changed value, such as a
// repriced event, changes it. Rows stored before block numbers were kept are included.
export async function rangeSignature(walletId: string, toBlock: number): Promise<string> {
  const res = await query<{ events: string; raw: string; fees: string }>(
    `SELECT
       (SELECT md5(COALESCE(string_agg(concat_ws(',', ne.id, ne.source_key, ne.supported, ne.token_address, ne.raw_amount,
                                                 ne.amount, ne.usd_value, ne.price_source, c.id, c.label, c.status),
                                       '|' ORDER BY ne.id), ''))
        FROM normalized_events ne
        LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
        WHERE ne.wallet_id = $1 AND (ne.block_number IS NULL OR ne.block_number <= $2)) AS events,
       (SELECT md5(COALESCE(string_agg(concat_ws(',', tx_hash, source_key, raw_amount), '|' ORDER BY tx_hash, source_key), ''))
        FROM raw_transfers WHERE wallet_id = $1 AND (block_number IS NULL OR block_number <= $2)) AS raw,
       (SELECT md5(COALESCE(string_agg(concat_ws(',', tx_hash, status, fee_wei), '|' ORDER BY tx_hash), ''))
        FROM raw_receipts WHERE wallet_id = $1 AND block_number <= $2) AS fees`,
    [walletId, toBlock],
  );
  const r = res.rows[0];
  return `${r.events}:${r.raw}:${r.fees}`;
}

// ---------------------------------------------------------------------------
// Asking for a check
// ---------------------------------------------------------------------------

export type AuditRequest =
  | { status: 'no_wallets' }
  | { status: 'running'; started_at: Date }
  | { status: 'started'; run_id: string; wallets: number }
  | { status: 'reused'; checked_at: string; unchanged: boolean; message: string };

export async function requestAudit(params: {
  userId: string;          // whose wallets
  requestedBy: string;     // who asked
  days?: number | null;
  admin?: boolean;
  timezone?: string;
  subject?: string;        // "your" (default) or "@alice's"
}): Promise<AuditRequest> {
  const days = params.days && params.days > 0 ? Math.min(Math.round(params.days), 365) : null;
  const wallets = await activeWallets(params.userId);
  if (wallets.length === 0) return { status: 'no_wallets' };

  const running = (await query<{ started_at: Date }>(
    `SELECT started_at FROM audit_runs WHERE user_id = $1 AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    [params.userId],
  )).rows[0];
  if (running) return { status: 'running', started_at: running.started_at };

  const last = (await query<{ id: string; result: AuditSummary; finished_at: Date }>(
    `SELECT id, result, finished_at FROM audit_runs
     WHERE user_id = $1 AND status = 'complete' AND days IS NOT DISTINCT FROM $2
     ORDER BY finished_at DESC LIMIT 1`,
    [params.userId, days],
  )).rows[0];
  const words = {
    timezone: params.timezone ?? await userTimezone(params.requestedBy),
    subject: params.subject ?? await subjectFor(params.userId, params.requestedBy),
  };

  // Does the earlier result still hold for the range it verified?
  let base: string | null = null;
  const apiKey = config.ALCHEMY_API_KEY;
  if (last && apiKey && Date.now() - new Date(last.finished_at).getTime() < REUSE_HOURS * 3_600_000) {
    const sameWallets = last.result.wallets.length === wallets.length
      && wallets.every((w) => last.result.wallets.some((lw) => lw.wallet_id === w.id));
    let holds = sameWallets && last.result.wallets.every((lw) => lw.signature !== null);
    for (const lw of holds ? last.result.wallets : []) {
      if (await rangeSignature(lw.wallet_id, lw.to_block) !== lw.signature) { holds = false; break; }
    }
    if (holds) {
      // Unchanged books over the verified range, and no new safe blocks since: reuse.
      // A provider that cannot give the tip means the chain cannot be compared: check.
      const safe = await safeBlock(apiKey).catch(() => null);
      if (safe !== null && last.result.wallets.every((lw) => safe <= lw.to_block)) {
        return { status: 'reused', checked_at: last.result.checked_at, unchanged: true, message: describeSummary(last.result, { ...words, reused: 'unchanged' }) };
      }
      // New blocks: verify only those, on top of the earlier result. A days-limited check
      // slides its window, so it is checked again in full.
      if (days === null) base = last.id;
    }
  }

  // Full checks an operator's own questions start per day are capped internally; past the
  // cap the latest result is given with its time, never presented as a limit. Checks of
  // only the new blocks are cheap and not capped.
  if (last && !base && !params.admin) {
    const today = (await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_runs
       WHERE user_id = $1 AND base_run_id IS NULL AND started_at > NOW() - INTERVAL '1 day'`,
      [params.userId],
    )).rows[0]?.n ?? 0;
    if (today >= OPERATOR_RUNS_PER_DAY) {
      return { status: 'reused', checked_at: last.result.checked_at, unchanged: false, message: describeSummary(last.result, { ...words, reused: 'stale' }) };
    }
  }

  const run = (await query<{ id: string }>(
    `INSERT INTO audit_runs (user_id, requested_by, days, base_run_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [params.userId, params.requestedBy, days, base],
  )).rows[0];
  void runAudit(run.id, words);
  return { status: 'started', run_id: run.id, wallets: wallets.length };
}

// What the chat model is told, so it replies in one sentence and never invents a result
export function auditRequestForModel(r: AuditRequest): Record<string, unknown> {
  switch (r.status) {
    case 'no_wallets':
      return { status: 'no_wallets', note: 'There are no wallets to check yet. Offer to start tracking one.' };
    case 'running':
      return { status: 'running', note: 'A check is already running. Say you will message them when it finishes. Do not state any result.' };
    case 'started':
      return { status: 'started', wallets: r.wallets, note: 'The check has started in the background. Say in one sentence that you are checking and will message them when it is done (usually a few minutes). Do not state any result.' };
    case 'reused':
      return { status: 'result', result: r.message, note: 'Pass this result on as written. Do not add numbers of your own.' };
  }
}

// ---------------------------------------------------------------------------
// Running a check
// ---------------------------------------------------------------------------

const TIME_CACHE = new Map<number, string | null>();
async function blockTime(apiKey: string, block: number | null): Promise<string | null> {
  if (block === null) return null;
  if (!TIME_CACHE.has(block)) {
    try {
      const b = await getBlock(apiKey, block);
      TIME_CACHE.set(block, b ? new Date(b.timestamp * 1000).toISOString() : null);
    } catch {
      return null; // a missing date is not worth failing a finished check over
    }
    if (TIME_CACHE.size > 5_000) TIME_CACHE.clear();
  }
  return TIME_CACHE.get(block) ?? null;
}

type WalletPart = { audit: WalletAudit; from_block: number; signature: string | null };

function emptyAudit(range: { wallet_id: string; address: string; from_block: number; to_block: number; synced_to: number | null }): WalletAudit {
  return {
    wallet: range.address, wallet_id: range.wallet_id, from_block: range.from_block, to_block: range.to_block,
    synced_to: range.synced_to, discovered: 0, transactions: 0, hashes: [],
    verdicts: { complete: 0, gaps: 0, not_tracked: 0, not_found: 0 }, movements: 0, lost: [], unknown: [], notes: {},
  };
}

// Combines this run's wallets with the earlier result it builds on (when only new blocks
// were verified). Ranges do not overlap, so counts add up.
export async function buildSummary(
  parts: WalletPart[],
  days: number | null,
  apiKey: string,
  base: AuditSummary | null = null,
): Promise<AuditSummary> {
  const gaps = Object.fromEntries(GAP_KINDS.map((k) => [k, [...(base?.gaps[k] ?? [])]])) as Record<GapKind, AuditEntry[]>;
  const unknown: AuditEntry[] = [...(base?.unknown ?? [])];
  let movements = base?.movements ?? 0;
  for (const { audit: a } of parts) {
    movements += a.movements;
    for (const l of a.lost) {
      // Past Luca's own sync: the sync has not reached it (or is stuck), not a provider miss
      const pastSync = (l.layer === 'provider' || l.layer === 'raw') && (a.synced_to === null || (l.block ?? 0) > a.synced_to);
      gaps[pastSync ? 'not_synced' : GAP_OF_LAYER[l.layer]].push({ ...l, wallet: a.wallet, time: await blockTime(apiKey, l.block) });
    }
    for (const u of a.unknown) unknown.push({ ...u, wallet: a.wallet, time: await blockTime(apiKey, u.block) });
  }
  const wallets: AuditSummary['wallets'] = [];
  for (const { audit: a, from_block, signature } of parts) {
    const prev = base?.wallets.find((w) => w.wallet_id === a.wallet_id);
    wallets.push({
      wallet_id: a.wallet_id, address: a.wallet, from_block, to_block: a.to_block,
      from_time: prev?.from_time ?? await blockTime(apiKey, from_block),
      to_time: await blockTime(apiKey, a.to_block),
      synced_to: a.synced_to, synced_to_time: await blockTime(apiKey, a.synced_to),
      signature,
    });
  }
  return {
    checked_at: new Date().toISOString(),
    days,
    wallets,
    // A transaction touching two of the operator's wallets is one transaction
    transactions: (base?.transactions ?? 0) + new Set(parts.flatMap((p) => p.audit.hashes)).size,
    movements,
    gaps,
    unknown,
  };
}

export async function runAudit(runId: string, words: { timezone?: string; subject?: string } = {}): Promise<void> {
  const run = (await query<{ user_id: string; requested_by: string | null; days: number | null; base_run_id: string | null }>(
    `SELECT user_id, requested_by, days, base_run_id FROM audit_runs WHERE id = $1`, [runId],
  )).rows[0];
  if (!run) return;
  const requester = run.requested_by ?? run.user_id;
  const timezone = words.timezone ?? await userTimezone(requester);
  const subject = words.subject ?? await subjectFor(run.user_id, requester);
  const apiKey = config.ALCHEMY_API_KEY;

  let text: string;
  try {
    if (!apiKey) throw new ProviderUnavailableError(new Error('ALCHEMY_API_KEY not set'));
    const safe = await safeBlock(apiKey);
    const base = run.base_run_id
      ? (await query<{ result: AuditSummary }>(`SELECT result FROM audit_runs WHERE id = $1`, [run.base_run_id])).rows[0]?.result ?? null
      : null;
    const parts: WalletPart[] = [];
    for (const w of await activeWallets(run.user_id)) {
      const range = await auditableRange(w.id, safe, run.days);
      if (!range) continue;
      const prev = base?.wallets.find((x) => x.wallet_id === w.id);
      // Building on an earlier result: only the blocks after it
      const checkFrom = prev ? prev.to_block + 1 : range.from_block;
      const window = { ...range, from_block: checkFrom };
      // The fingerprint is kept only if the books did not change while this wallet was checked
      const before = await rangeSignature(w.id, window.to_block);
      const audit = window.from_block > window.to_block ? emptyAudit(window) : await auditRange(window, apiKey, { pauseMs: 100 });
      const after = await rangeSignature(w.id, window.to_block);
      parts.push({ audit, from_block: prev ? prev.from_block : range.from_block, signature: before === after ? after : null });
    }
    const summary = await buildSummary(parts, run.days, apiKey, base);
    await query(
      `UPDATE audit_runs SET status = 'complete', result = $2, finished_at = NOW() WHERE id = $1`,
      [runId, JSON.stringify(summary)],
    );
    text = describeSummary(summary, { timezone, subject });
    logger.info({ runId, userId: run.user_id, transactions: summary.transactions, incremental: Boolean(base) }, 'Books check complete');
  } catch (err) {
    const provider = err instanceof ProviderUnavailableError;
    await query(
      `UPDATE audit_runs SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
      [runId, err instanceof Error ? err.message : String(err)],
    );
    logger.warn({ err, runId, userId: run.user_id }, 'Books check could not finish');
    text = provider ? providerDownText(subject) : internalErrorText(subject);
  }
  await deliver(runId, requester, text);
}

async function deliver(runId: string, requester: string, text: string): Promise<void> {
  if (!notify) {
    logger.warn({ runId }, 'Books check finished with no way to deliver it');
    return;
  }
  try {
    await notify(requester, text);
    await query(`UPDATE audit_runs SET delivered_at = NOW() WHERE id = $1`, [runId]);
  } catch (err) {
    logger.error({ err, runId }, 'Could not deliver the books check result');
  }
}

// After a restart: checks that were running are marked interrupted, then retried once;
// a check interrupted twice is reported instead.
export async function recoverAudits(): Promise<number> {
  const res = await query<{ id: string; attempts: number; requested_by: string | null; user_id: string; started_at: Date }>(
    `UPDATE audit_runs SET status = 'interrupted', finished_at = NOW()
     WHERE status = 'running'
     RETURNING id, attempts, requested_by, user_id, started_at`,
  );
  for (const r of res.rows) {
    if (r.attempts < MAX_ATTEMPTS) {
      await query(
        `UPDATE audit_runs SET status = 'running', attempts = attempts + 1, finished_at = NULL WHERE id = $1`, [r.id],
      );
      logger.info({ runId: r.id }, 'Books check interrupted by a restart; running it again');
      void runAudit(r.id);
    } else {
      const requester = r.requested_by ?? r.user_id;
      const subject = await subjectFor(r.user_id, requester);
      await deliver(r.id, requester, interruptedText(subject, r.started_at, await userTimezone(requester)));
    }
  }
  return res.rows.length;
}

// True when a movement is not in the books (or is in them wrongly); a movement that is
// only unlabeled or unpriced is in the books
export function isMissing(layer: TraceLayer | null): boolean {
  return layer !== null && MISSING.includes(GAP_OF_LAYER[layer]);
}

// One movement of one transaction, for "did you see transaction 0x…?"
export function movementStatus(m: {
  lost_at: TraceLayer | null; label_status: string | null; books: { figure: string } | null;
}): string {
  if (m.lost_at) return GAP_WORDS[GAP_OF_LAYER[m.lost_at]];
  if (m.label_status === 'unknown') return "it's in your books, labeled unknown until you tell me what it was";
  if (m.books) {
    const as = { revenue: 'revenue', expenses: 'an expense', gas: 'a network fee', internal: 'an internal transfer', swap: 'part of a swap', unknown: 'unknown' }[m.books.figure] ?? m.books.figure;
    return `it's in your books as ${as}${m.label_status === 'provisional' ? ' (my best guess, not confirmed)' : ''}`;
  }
  return "it's in your records";
}

// ---------------------------------------------------------------------------
// Wording: deterministic, from the check's own numbers
// ---------------------------------------------------------------------------

async function userTimezone(userId: string): Promise<string | undefined> {
  return (await query<{ timezone: string }>(`SELECT timezone FROM users WHERE id = $1`, [userId])).rows[0]?.timezone;
}

async function subjectFor(ownerId: string, requesterId: string): Promise<string> {
  if (ownerId === requesterId) return 'your';
  const u = (await query<{ telegram_username: string | null }>(`SELECT telegram_username FROM users WHERE id = $1`, [ownerId])).rows[0];
  return u?.telegram_username ? `@${u.telegram_username.replace(/^@/, '')}'s` : "this operator's";
}

function fmtDate(iso: string | null, timezone: string | undefined, withTime = false): string | null {
  if (!iso) return null;
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'short', day: 'numeric' };
  try {
    return new Date(iso).toLocaleString('en-US', { ...opts, timeZone: timezone });
  } catch {
    return new Date(iso).toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
  }
}

export function amountText(e: { raw_amount: string | null; asset: string | null }): string {
  if (!e.raw_amount || !e.asset) return e.asset ?? 'a transfer';
  const decimals = e.asset === 'ETH' ? 18
    : Object.values(SUPPORTED_TOKENS).find((t) => t.symbol === e.asset)?.decimals ?? 18;
  const n = Number(BigInt(e.raw_amount)) / 10 ** decimals;
  const shown = e.asset === 'USDC' ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : significant(n);
  return `${shown} ${e.asset}`;
}

function entryText(e: AuditEntry, timezone: string | undefined): string {
  const when = fmtDate(e.time, timezone) ?? `block ${e.block ?? '?'}`;
  const what = e.source_key === 'gas' ? `network fee of ${amountText(e)}` : `${amountText(e)}${e.direction ? ` ${e.direction}` : ''}`;
  return `${when}, ${what} (${e.hash.slice(0, 6)}…${e.hash.slice(-4)})`;
}

// "everything I've tracked since Sep 1 across your 2 wallets"
// "everything I've tracked across your 2 wallets from Sep 1 to Sep 26 10:35": the exact
// range the check verified, never "all"
function coverageText(s: AuditSummary, timezone: string | undefined, subject: string): string {
  const starts = s.wallets.map((w) => w.from_time).filter((t): t is string => Boolean(t)).sort();
  const ends = s.wallets.map((w) => w.to_time).filter((t): t is string => Boolean(t)).sort();
  const since = starts[0] ? fmtDate(starts[0], timezone, s.days !== null) : null;
  const until = ends.length ? fmtDate(ends[ends.length - 1], timezone, true) : null;
  const walletsText = s.wallets.length === 1 ? `${subject} wallet` : `${subject} ${s.wallets.length} wallets`;
  // One day: "Sep 21, up to 14:30"; otherwise "Sep 1 to Sep 26, 14:30"
  const sameDay = since && until && until.startsWith(since.split(',')[0]);
  const span = since && until
    ? (sameDay ? `${since.split(',')[0]}, up to ${until.split(', ').pop()}` : `${since} to ${until}`)
    : null;
  if (s.days !== null) {
    const period = s.days === 1 ? 'the last day' : `the last ${s.days} days`;
    return `everything across ${walletsText} over ${period}${span ? ` (${span})` : ''}`;
  }
  return `everything I've tracked across ${walletsText}${span ? (sameDay ? ` on ${span}` : ` from ${span}`) : ''}`;
}

export function describeSummary(
  s: AuditSummary,
  o: { timezone?: string; subject?: string; reused?: 'unchanged' | 'stale' } = {},
): string {
  const subject = o.subject ?? 'your';
  const books = `${subject} books`;
  const lines: string[] = [];
  const at = fmtDate(s.checked_at, o.timezone, true);
  if (o.reused === 'unchanged') lines.push(`Nothing has changed in ${books} since I checked at ${at}.`);
  if (o.reused === 'stale') lines.push(`This is from my check at ${at}; anything that arrived since then is not in it yet.`);

  const tx = `${s.transactions} transaction${s.transactions === 1 ? '' : 's'}`;
  const mv = `${s.movements} supported financial movement${s.movements === 1 ? '' : 's'}`;
  lines.push(`I checked ${coverageText(s, o.timezone, subject)}: ${tx}, ${mv}.`);

  const missing = MISSING.flatMap((k) => s.gaps[k].map((e) => ({ k, e })));
  const incomplete = (['unclassified', 'missing_price'] as GapKind[]).flatMap((k) => s.gaps[k].map((e) => ({ k, e })));

  if (missing.length === 0 && incomplete.length === 0) {
    lines.push(`Every supported movement reached ${books}.`);
  }
  const movementsN = (n: number): string => `${n} movement${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'}`;
  if (missing.length > 0) {
    const wrong = missing.filter(({ k }) => k === 'not_on_chain').length;
    const state = wrong === 0 ? 'missing from' : wrong === missing.length ? 'wrong in' : 'missing or wrong in';
    lines.push('', `${movementsN(missing.length)} ${state} ${books}:`);
    for (const { k, e } of missing) {
      let why = GAP_WORDS[k];
      if (k === 'not_synced') {
        const reached = s.wallets.find((w) => w.address === e.wallet)?.synced_to_time;
        why = reached
          ? `I haven't synced it yet (my last sync of this wallet reached ${fmtDate(reached, o.timezone, true)}), so it's missing from your books`
          : GAP_WORDS[k];
      }
      lines.push(`- ${entryText(e, o.timezone)}: ${why}.`);
    }
  }
  if (incomplete.length > 0) {
    lines.push('', `${movementsN(incomplete.length)} in ${books} but not finished:`);
    for (const { k, e } of incomplete) lines.push(`- ${entryText(e, o.timezone)}: ${GAP_WORDS[k]}.`);
  }
  if (s.unknown.length > 0) {
    const n = s.unknown.length;
    lines.push('', `${movementsN(n)} still labeled unknown, waiting for ${subject === 'your' ? 'you' : 'the operator'} to say what ${n === 1 ? 'it was' : 'they were'}. ${n === 1 ? "It's" : "They're"} in ${books}, not missing.`);
  }
  if (missing.length > 0 || incomplete.length > 0) lines.push('', `I haven't changed anything in ${books}.`);
  return lines.join('\n');
}

function providerDownText(subject: string): string {
  const w = subject === 'your' ? 'your wallets' : `${subject} wallets`;
  return `I couldn't finish checking ${w}: my blockchain data provider isn't responding right now. Nothing in the books has changed. Ask me again in a few minutes and I'll run the check again.`;
}

function internalErrorText(subject: string): string {
  const w = subject === 'your' ? 'your wallets' : `${subject} wallets`;
  return `I couldn't finish checking ${w} because of an error on my side. Nothing in the books has changed, and the error is logged.`;
}

function interruptedText(subject: string, startedAt: Date, timezone: string | undefined): string {
  const w = subject === 'your' ? 'your wallets' : `${subject} wallets`;
  return `I started checking ${w} at ${fmtDate(new Date(startedAt).toISOString(), timezone, true)}, but I was restarted before it finished, twice. Nothing in the books has changed. Ask me again and I'll run the check again.`;
}
