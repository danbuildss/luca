import { query } from '../db.js';
import { txLink } from '../ledger/links.js';
import { significant, usdDisplay } from '../books/breakdown.js';
import { getValuedBalances, type ValuedBalances } from '../books/balances.js';
import { escapeLegacyMarkdown } from '../telegram/format.js';
import { feeSourceStatus, type FeeSourceStatus } from './sources.js';

// What Luca says about creator fees, in fixed wording written here, never the model's.
// Bankr's numbers are always "reported by Bankr"; only transfers whose receipts tie
// them to the pool are "verified on-chain". Nothing adds them up into "earned": a claim
// moves fees from claimable to claimed, and Bankr's lifetime figures are not usable.
// Luca follows the fees; it does not track the token that pays them.

export const NO_FEE_SOURCES = "I'm not following any creator fees for you. An admin can add a token's fees for a wallet I track.";

type Balance = { amount: number; usd: number | null; as_of: Date } | null;

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
// Token symbols come from Bankr: letters, digits and a few marks only
const symbol = (s: string): string => s.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 20) || 'token';

function amount(s: string | number): string {
  const n = typeof s === 'number' ? s : parseFloat(s);
  if (!Number.isFinite(n)) return String(s);
  const abs = Math.abs(n);
  return abs >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : significant(n, 4);
}

async function clock(userId: string): Promise<(d: Date) => string> {
  const tz = (await query<{ timezone: string | null }>(`SELECT timezone FROM users WHERE id = $1`, [userId])).rows[0]?.timezone ?? 'UTC';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' };
  return (d: Date) => {
    try { return new Date(d).toLocaleString('en-US', { ...opts, timeZone: tz }); }
    catch { return new Date(d).toLocaleString('en-US', { ...opts, timeZone: 'UTC' }); }
  };
}

// The fee wallet's latest fee-asset balance, valued at today's price
function feeWalletBalances(statuses: FeeSourceStatus[], valued: ValuedBalances): Map<string, Balance> {
  const out = new Map<string, Balance>();
  for (const s of statuses) {
    const b = valued.balances.find((v) => v.wallet_id === s.source.wallet_id && v.asset === s.source.fee_asset);
    out.set(s.source.id, b ? { amount: b.balance, usd: b.usd_value, as_of: b.snapshot_at } : null);
  }
  return out;
}

function describeOne(s: FeeSourceStatus, balance: Balance, at: (d: Date) => string, bnkrPrice: number | null): string {
  const src = s.source;
  const sym = symbol(src.token_symbol);
  const asset = src.fee_asset;
  const lines: string[] = [
    `*${escapeLegacyMarkdown(sym)} creator fees*, paid in ${asset} to ${short(src.wallet_address)}`,
    `${escapeLegacyMarkdown(sym)} token ${short(src.token_address)}. I follow these fees; ${escapeLegacyMarkdown(sym)} itself is not a token I track.`,
    '',
  ];

  if (s.reported) {
    const value = bnkrPrice !== null ? ` (about ${usdDisplay(parseFloat(s.reported.claimable) * bnkrPrice)} at today's ${asset} price)` : '';
    lines.push(`Reported by Bankr, ${at(s.reported.read_at)}${s.reported_stale ? ' (over 2 hours old)' : ''}:`);
    lines.push(`- Claimable: ${amount(s.reported.claimable)} ${asset}${value}`);
    lines.push(`- Claimed so far: ${amount(s.reported.claimed)} ${asset} in ${s.reported.claim_count} ${s.reported.claim_count === 1 ? 'claim' : 'claims'}`);
    const c = s.claimable_change;
    if (c) {
      const n = parseFloat(c.change);
      const since = `since ${at(c.since)}${c.full_day ? '' : ' (my readings cover less than a day)'}`;
      lines.push(n > 0 ? `- Claimable rose ${amount(n)} ${asset} ${since}`
        : n < 0 ? `- Claimable fell ${amount(-n)} ${asset} ${since}; a claim lowers it`
          : `- Claimable is unchanged ${since}`);
    }
  } else {
    lines.push('Reported by Bankr: I have no reading yet.');
  }
  if (s.last_error) {
    lines.push(`- My latest read of Bankr failed, ${at(s.last_error.read_at)}: ${escapeLegacyMarkdown(s.last_error.error)}.${s.reported ? ' The figures above are from the last reading that worked.' : ''}`);
  }

  lines.push('', 'Verified on-chain:');
  if (s.verified.count === 0) {
    lines.push(`- No claims into ${short(src.wallet_address)} yet`);
  } else {
    const usd = s.verified.usd_when_claimed !== null ? ` (${usdDisplay(s.verified.usd_when_claimed)} when claimed)` : '';
    const last = s.verified.last ? `; the last on ${at(s.verified.last.block_time)}, ${txLink(s.verified.last.hash)}` : '';
    lines.push(`- ${s.verified.count} ${s.verified.count === 1 ? 'claim' : 'claims'}, ${amount(s.verified.total)} ${asset}${usd}${last}`);
  }
  const r = s.reconciliation;
  if (r.status === 'match') lines.push("- Bankr's claimed figure matches the chain");
  else if (r.status === 'mismatch') {
    lines.push(`- Bankr and the chain disagree: Bankr reports ${amount(r.reported_claimed)} ${asset} claimed in ${r.reported_count} ${r.reported_count === 1 ? 'claim' : 'claims'}; I can verify ${amount(r.verified_claimed)} ${asset} in ${r.verified_count}`);
  }
  if (s.unclear > 0) {
    lines.push(`- ${s.unclear} ${s.unclear === 1 ? 'transfer' : 'transfers'} from the fee contract could not be tied to ${escapeLegacyMarkdown(sym)} alone, so ${s.unclear === 1 ? 'it stays' : 'they stay'} unknown until you tell me what ${s.unclear === 1 ? 'it was' : 'they were'}`);
  }

  lines.push('');
  if (balance) {
    lines.push(`${asset} in ${short(src.wallet_address)}: ${amount(balance.amount)}${balance.usd !== null ? ` (${usdDisplay(balance.usd)})` : ''}, as of ${at(balance.as_of)}`);
  }
  lines.push('Staking and rewards: not active.');
  return lines.join('\n');
}

export async function feeReport(userId: string): Promise<string> {
  const statuses = await feeSourceStatus(userId);
  if (statuses.length === 0) return NO_FEE_SOURCES;
  const [at, valued] = await Promise.all([clock(userId), getValuedBalances(userId)]);
  const balances = feeWalletBalances(statuses, valued);
  return statuses.map((s) => describeOne(s, balances.get(s.source.id) ?? null, at, valued.prices.BNKR)).join('\n\n');
}

// The same figures for a machine: every number with its source and time
export async function feeMachineReport(userId: string, now: Date = new Date()): Promise<Record<string, unknown>> {
  const statuses = await feeSourceStatus(userId);
  const balances = statuses.length > 0 ? feeWalletBalances(statuses, await getValuedBalances(userId)) : new Map<string, Balance>();
  return {
    report: 'luca.creator_fees.v1',
    generated_at: now.toISOString(),
    read_only: true,
    sources: statuses.map((s) => {
      const b = balances.get(s.source.id) ?? null;
      return {
        token: { address: s.source.token_address, symbol: symbol(s.source.token_symbol), tracked_by_luca: false },
        chain: 'base',
        fee_wallet: s.source.wallet_address,
        provider: s.source.provider,
        pool_id: s.source.pool_id,
        fee_contract: s.source.fee_contract,
        fee_asset: s.source.fee_asset,
        fee_token: s.source.fee_token,
        reported_by_bankr: s.reported
          ? { claimable: s.reported.claimable, claimed: s.reported.claimed, claim_count: s.reported.claim_count, read_at: new Date(s.reported.read_at).toISOString(), stale: s.reported_stale }
          : null,
        latest_read_error: s.last_error ? { message: s.last_error.error, at: new Date(s.last_error.read_at).toISOString() } : null,
        claimable_change: s.claimable_change
          ? { change: s.claimable_change.change, since: new Date(s.claimable_change.since).toISOString(), until: new Date(s.claimable_change.until).toISOString(), full_day: s.claimable_change.full_day }
          : null,
        verified_onchain: {
          claim_count: s.verified.count,
          claimed: s.verified.total,
          usd_when_claimed: s.verified.usd_when_claimed,
          last_claim: s.verified.last
            ? { tx: s.verified.last.hash, block_time: new Date(s.verified.last.block_time).toISOString(), amount: s.verified.last.amount }
            : null,
        },
        unproven_fee_transfers: s.unclear,
        reconciliation: s.reconciliation,
        fee_wallet_balance: b ? { asset: s.source.fee_asset, amount: String(b.amount), as_of: new Date(b.as_of).toISOString() } : null,
        staking: 'not_active',
        rewards: 'not_active',
      };
    }),
  };
}

export async function feeMachineReportText(userId: string): Promise<string> {
  const report = await feeMachineReport(userId);
  if ((report.sources as unknown[]).length === 0) return NO_FEE_SOURCES;
  // Inside a Telegram code block: no backticks from any field
  const json = JSON.stringify(report, null, 2).replace(/`/g, "'");
  return `Machine report (JSON, read-only):\n\`\`\`\n${json}\n\`\`\``;
}
