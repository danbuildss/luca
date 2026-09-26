import { query } from '../db.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { getBlock } from '../ingestion/alchemy.js';
import { SUPPORTED_TOKENS } from '../ingestion/assets.js';
import { significant } from '../books/breakdown.js';
import { auditRange, syncedRange, ProviderUnavailableError, type AuditItem, type WalletAudit } from './audit.js';
import type { TraceLayer } from './trace.js';

// "Are my books complete?" from chat. A check compares everything the chain and the data
// providers know for an operator's wallets with what reached the books (src/ledger/audit.ts).
// It runs in the background and is recorded in audit_runs, so a restart mid-check is
// known and retried, a recent result is reused while the books have not changed, and the
// outcome is sent to whoever asked exactly once. Read-only: a check never changes books.

// Where a movement stopped, in the operator's terms
export const GAP_KINDS = [
  'missing_from_provider', 'provider_not_stored', 'stored_not_normalized', 'unsupported', 'not_on_chain',
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
const MISSING: GapKind[] = ['missing_from_provider', 'provider_not_stored', 'stored_not_normalized', 'unsupported', 'not_on_chain'];

const GAP_WORDS: Record<GapKind, string> = {
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
  wallets: Array<{ address: string; from_block: number; to_block: number; from_time: string | null; to_time: string | null }>;
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

// Changes when a transfer, fee, label or price is added or changes, or a wallet is added.
// New empty blocks do not change it, so an unchanged result is reused.
export async function booksSignature(userId: string, days: number | null): Promise<string> {
  const res = await query<{ sig: string | null }>(
    `SELECT string_agg(
              w.id::text || ':' ||
              (SELECT COUNT(*) FROM normalized_events ne WHERE ne.wallet_id = w.id)::text || ':' ||
              (SELECT COUNT(*) FROM raw_receipts rr WHERE rr.wallet_id = w.id)::text || ':' ||
              (SELECT COUNT(*) FROM normalized_events ne WHERE ne.wallet_id = w.id AND ne.usd_value IS NOT NULL)::text || ':' ||
              COALESCE((SELECT MAX(c.created_at)::text FROM classifications c
                        JOIN normalized_events ne ON ne.id = c.event_id WHERE ne.wallet_id = w.id), '-'),
              '|' ORDER BY w.id) AS sig
     FROM wallets w WHERE w.user_id = $1 AND w.active = TRUE AND w.chain = 'base'`,
    [userId],
  );
  return `${days ?? 'all'}#${res.rows[0]?.sig ?? ''}`;
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

  const signature = await booksSignature(params.userId, days);
  const last = (await query<{ result: AuditSummary; signature: string; finished_at: Date }>(
    `SELECT result, signature, finished_at FROM audit_runs
     WHERE user_id = $1 AND status = 'complete' AND days IS NOT DISTINCT FROM $2
     ORDER BY finished_at DESC LIMIT 1`,
    [params.userId, days],
  )).rows[0];
  const fresh = last && Date.now() - new Date(last.finished_at).getTime() < REUSE_HOURS * 3_600_000;
  const words = {
    timezone: params.timezone ?? await userTimezone(params.requestedBy),
    subject: params.subject ?? await subjectFor(params.userId, params.requestedBy),
  };
  if (last && fresh && last.signature === signature) {
    return { status: 'reused', checked_at: last.result.checked_at, unchanged: true, message: describeSummary(last.result, { ...words, reused: 'unchanged' }) };
  }
  if (last && !params.admin) {
    const today = (await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_runs WHERE user_id = $1 AND started_at > NOW() - INTERVAL '1 day'`,
      [params.userId],
    )).rows[0]?.n ?? 0;
    if (today >= OPERATOR_RUNS_PER_DAY) {
      return { status: 'reused', checked_at: last.result.checked_at, unchanged: false, message: describeSummary(last.result, { ...words, reused: 'stale' }) };
    }
  }

  const run = (await query<{ id: string }>(
    `INSERT INTO audit_runs (user_id, requested_by, days, signature) VALUES ($1, $2, $3, $4) RETURNING id`,
    [params.userId, params.requestedBy, days, signature],
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

export async function buildSummary(audits: WalletAudit[], days: number | null, apiKey: string): Promise<AuditSummary> {
  const gaps = Object.fromEntries(GAP_KINDS.map((k) => [k, [] as AuditEntry[]])) as Record<GapKind, AuditEntry[]>;
  const unknown: AuditEntry[] = [];
  const hashes = new Set<string>();
  let movements = 0;
  for (const a of audits) {
    movements += a.movements;
    for (const l of a.lost) {
      hashes.add(l.hash);
      gaps[GAP_OF_LAYER[l.layer]].push({ ...l, wallet: a.wallet, time: await blockTime(apiKey, l.block) });
    }
    for (const u of a.unknown) unknown.push({ ...u, wallet: a.wallet, time: await blockTime(apiKey, u.block) });
  }
  return {
    checked_at: new Date().toISOString(),
    days,
    wallets: await Promise.all(audits.map(async (a) => ({
      address: a.wallet, from_block: a.from_block, to_block: a.to_block,
      from_time: await blockTime(apiKey, a.from_block), to_time: await blockTime(apiKey, a.to_block),
    }))),
    // A transaction touching two of the operator's wallets is one transaction
    transactions: new Set(audits.flatMap((a) => a.hashes)).size,
    movements,
    gaps,
    unknown,
  };
}

export async function runAudit(runId: string, words: { timezone?: string; subject?: string } = {}): Promise<void> {
  const run = (await query<{ user_id: string; requested_by: string | null; days: number | null; started_at: Date }>(
    `SELECT user_id, requested_by, days, started_at FROM audit_runs WHERE id = $1`, [runId],
  )).rows[0];
  if (!run) return;
  const requester = run.requested_by ?? run.user_id;
  const timezone = words.timezone ?? await userTimezone(requester);
  const subject = words.subject ?? await subjectFor(run.user_id, requester);
  const apiKey = config.ALCHEMY_API_KEY;

  let text: string;
  try {
    if (!apiKey) throw new ProviderUnavailableError(new Error('ALCHEMY_API_KEY not set'));
    const audits: WalletAudit[] = [];
    for (const w of await activeWallets(run.user_id)) {
      const range = await syncedRange(w.id, run.days);
      if (range) audits.push(await auditRange(range, apiKey, { pauseMs: 100 }));
    }
    const summary = await buildSummary(audits, run.days, apiKey);
    await query(
      `UPDATE audit_runs SET status = 'complete', result = $2, finished_at = NOW() WHERE id = $1`,
      [runId, JSON.stringify(summary)],
    );
    text = describeSummary(summary, { timezone, subject });
    logger.info({ runId, userId: run.user_id, transactions: summary.transactions }, 'Books check complete');
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
function coverageText(s: AuditSummary, timezone: string | undefined, subject: string): string {
  const starts = s.wallets.map((w) => w.from_time).filter((t): t is string => Boolean(t)).sort();
  const since = starts[0] ? fmtDate(starts[0], timezone, s.days !== null) : null;
  const walletsText = s.wallets.length === 1 ? `${subject} wallet` : `${subject} ${s.wallets.length} wallets`;
  if (s.days !== null) {
    const period = s.days === 1 ? 'the last day' : `the last ${s.days} days`;
    return `everything across ${walletsText} over ${period}${since ? ` (since ${since})` : ''}`;
  }
  return `everything I've tracked${since ? ` since ${since}` : ''} across ${walletsText}`;
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
  const mv = `${s.movements} movement${s.movements === 1 ? '' : 's'} of ETH, USDC and BNKR`;
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
    for (const { k, e } of missing) lines.push(`- ${entryText(e, o.timezone)}: ${GAP_WORDS[k]}.`);
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
