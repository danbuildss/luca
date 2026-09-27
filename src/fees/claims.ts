import { query } from '../db.js';
import { logger } from '../logger.js';
import { ClassificationLabel } from '../types/index.js';
import { getTransactionReceipt, type TxReceipt } from '../ingestion/alchemy.js';
import { saveManyClassifications } from '../classification/store.js';
import type { ClassificationResult } from '../classification/types.js';
import type { FeeSource } from './sources.js';

// Is a fee-asset transfer into the fee wallet a claim of this source's creator fees?
// Decided from the transaction receipt, never from Bankr's numbers or the model:
//
//   claim     the transfer comes from the fee contract, or the fee contract logged an
//             event for this pool in the same transaction, and nothing in it belongs to
//             another pool. Becomes revenue, tied to the source.
//   unclear   the fee contract is involved, but the evidence does not tie the transfer to
//             this pool alone (another pool is in the transaction, or the contract's
//             events carry no pool). Stays unknown: unknown is better than false revenue.
//   unrelated the fee contract is not involved. Labeled like any other transfer.

export type ClaimVerdict = 'claim' | 'unclear' | 'unrelated';

export type ClaimEvidence = {
  from_fee_contract: boolean;
  fee_contract_events: number;
  pool_events: number;           // fee-contract events keyed by this source's pool
  other_pools: string[];         // fee-contract events keyed by any other pool
  reason: string;
};

type ReceiptLog = { address: string; topics: string[] };

// An indexed address is 12 zero bytes then 20 bytes; a pool id is a full bytes32
function isPoolTopic(topic: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(topic) && !topic.startsWith('0x000000000000000000000000');
}

export function decideClaim(
  source: Pick<FeeSource, 'pool_id' | 'fee_contract'>,
  transfer: { from_address: string },
  receipt: { status: 'success' | 'failed'; logs: ReceiptLog[] },
): { verdict: ClaimVerdict; evidence: ClaimEvidence } {
  const fromFeeContract = transfer.from_address.toLowerCase() === source.fee_contract;
  const feeLogs = receipt.logs.filter((l) => l.address.toLowerCase() === source.fee_contract);
  const keyed = feeLogs.map((l) => (l.topics[1] ?? '').toLowerCase()).filter(isPoolTopic);
  const poolEvents = keyed.filter((t) => t === source.pool_id).length;
  const otherPools = [...new Set(keyed.filter((t) => t !== source.pool_id))];
  const evidence = (reason: string): ClaimEvidence => ({
    from_fee_contract: fromFeeContract, fee_contract_events: feeLogs.length, pool_events: poolEvents, other_pools: otherPools, reason,
  });

  if (receipt.status !== 'success') return { verdict: 'unrelated', evidence: evidence('The transaction failed') };
  if (!fromFeeContract && feeLogs.length === 0) {
    return { verdict: 'unrelated', evidence: evidence('The fee contract is not part of this transaction') };
  }
  if (otherPools.length > 0) {
    return { verdict: 'unclear', evidence: evidence(`The fee contract also recorded ${otherPools.length === 1 ? 'another pool' : `${otherPools.length} other pools`} in this transaction`) };
  }
  if (fromFeeContract || poolEvents > 0) {
    return {
      verdict: 'claim',
      evidence: evidence(fromFeeContract
        ? `Paid by the fee contract${poolEvents > 0 ? ', which recorded this pool in the same transaction' : ''}`
        : 'The fee contract recorded this pool in the same transaction'),
    };
  }
  return { verdict: 'unclear', evidence: evidence('The fee contract is part of this transaction, but none of its events name a pool') };
}

const short = (h: string): string => `${h.slice(0, 6)}…${h.slice(-4)}`;

// The label a checked transfer gets (null: label it like any other transfer)
export function feeLabel(
  source: Pick<FeeSource, 'id' | 'token_symbol' | 'pool_id' | 'fee_contract'>,
  check: { verdict: ClaimVerdict; evidence: ClaimEvidence },
): ClassificationResult | null {
  if (check.verdict === 'claim') {
    return {
      label: ClassificationLabel.REVENUE,
      confidence: 1.0,
      method: 'deterministic',
      evidence: `${source.token_symbol} creator fees claimed from Bankr's fee contract ${short(source.fee_contract)} (pool ${short(source.pool_id)}). ${check.evidence.reason}.`,
      fee_source_id: source.id,
    };
  }
  if (check.verdict === 'unclear') {
    return {
      label: ClassificationLabel.UNKNOWN,
      confidence: 0,
      method: 'deterministic',
      evidence: `Possibly ${source.token_symbol} creator fees, but not proven: ${check.evidence.reason}. Needs your answer.`,
    };
  }
  return null;
}

// Fee-asset transfers into the fee wallet that have not been checked yet
async function uncheckedTransfers(source: FeeSource, limit: number): Promise<Array<{ id: string; hash: string; from_address: string }>> {
  const res = await query<{ id: string; hash: string; from_address: string }>(
    `SELECT ne.id, ne.hash, ne.from_address
     FROM normalized_events ne
     WHERE ne.user_id = $1 AND ne.wallet_id = $2 AND ne.direction = 'in' AND ne.supported IS TRUE
       AND LOWER(ne.token_address) = $3 AND LOWER(ne.to_address) = $4 AND ne.amount > 0
       AND NOT EXISTS (SELECT 1 FROM fee_claim_checks k WHERE k.event_id = ne.id)
     ORDER BY ne.block_time
     LIMIT $5`,
    [source.user_id, source.wallet_id, source.fee_token, source.wallet_address, limit],
  );
  return res.rows;
}

export async function getFeeChecks(eventIds: string[]): Promise<Map<string, { fee_source_id: string; verdict: ClaimVerdict; evidence: ClaimEvidence }>> {
  const out = new Map<string, { fee_source_id: string; verdict: ClaimVerdict; evidence: ClaimEvidence }>();
  if (eventIds.length === 0) return out;
  const res = await query<{ event_id: string; fee_source_id: string; verdict: ClaimVerdict; evidence: ClaimEvidence }>(
    `SELECT event_id, fee_source_id, verdict, evidence FROM fee_claim_checks WHERE event_id = ANY($1::uuid[])`,
    [eventIds],
  );
  for (const r of res.rows) out.set(r.event_id, r);
  return out;
}

type GetReceipt = (apiKey: string, hash: string) => Promise<TxReceipt | null>;

type Check = { source: FeeSource; verdict: ClaimVerdict; evidence: ClaimEvidence };

// Several sources can pay the same wallet through the same fee contract (two tokens
// named ACCUM do). Then a transfer is a claim only when the transaction names exactly one
// of their pools and no pool Luca does not follow; anything else stays unknown.
export function decideAcrossSources(
  sources: FeeSource[],
  transfer: { from_address: string },
  receipt: { status: 'success' | 'failed'; logs: ReceiptLog[] },
): Check {
  if (sources.length === 1) return { source: sources[0], ...decideClaim(sources[0], transfer, receipt) };
  const checks = sources.map((source) => ({ source, ...decideClaim(source, transfer, receipt) }));
  if (checks.every((c) => c.verdict === 'unrelated')) return checks[0];
  const known = new Set(sources.map((s) => s.pool_id));
  const named = checks.filter((c) => c.evidence.pool_events > 0);
  // Pools in the transaction other than the first source's own; its own pool is known
  const untracked = checks[0].evidence.other_pools.filter((p) => !known.has(p)).length;
  const unclear = (c: Check, reason: string): Check => ({ ...c, verdict: 'unclear', evidence: { ...c.evidence, reason } });

  if (untracked > 0) return unclear(checks[0], 'The fee contract also recorded a pool Luca does not follow in this transaction');
  if (named.length === 1) {
    const c = named[0];
    return { ...c, verdict: 'claim', evidence: { ...c.evidence, other_pools: [], reason: 'The fee contract recorded this pool, and no other, in the same transaction' } };
  }
  if (named.length > 1) return unclear(named[0], `The fee contract recorded ${named.length} tracked pools in this transaction`);
  return unclear(checks[0], `The fee contract pays ${sources.length} tracked tokens to this wallet and nothing in the transaction says which one`);
}

// Runs before classification each cycle. A transfer whose receipt cannot be read now is
// left unchecked (and unlabeled) and tried again next cycle.
export async function checkFeeClaims(apiKey: string, sources: FeeSource[], getReceipt: GetReceipt = getTransactionReceipt, limit = 50): Promise<number> {
  const groups = new Map<string, FeeSource[]>();
  for (const s of sources) {
    const key = `${s.wallet_id}:${s.fee_token}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  let checked = 0;
  for (const group of groups.values()) {
    for (const t of await uncheckedTransfers(group[0], limit)) {
      let receipt: TxReceipt | null;
      try {
        receipt = await getReceipt(apiKey, t.hash);
      } catch (err) {
        logger.warn({ err, hash: t.hash }, 'Fee claim check: receipt not readable, retrying next cycle');
        continue;
      }
      if (!receipt) continue;
      const logs = Array.isArray(receipt.raw.logs) ? receipt.raw.logs as ReceiptLog[] : [];
      const check = decideAcrossSources(group, t, { status: receipt.status, logs });
      await query(
        `INSERT INTO fee_claim_checks (event_id, fee_source_id, verdict, evidence) VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id) DO NOTHING`,
        [t.id, check.source.id, check.verdict, JSON.stringify(check.evidence)],
      );
      checked++;
      await relabelChecked(check.source, t.id, check);
    }
  }
  return checked;
}

// A transfer already labeled automatically as a single payment takes the checked label
// now. The operator's own labels are never touched (saveManyClassifications), and
// swaps or mixed transactions keep what their shape decided.
async function relabelChecked(source: FeeSource, eventId: string, check: { verdict: ClaimVerdict; evidence: ClaimEvidence }): Promise<void> {
  const result = feeLabel(source, check);
  if (!result) return;
  const active = (await query<{ id: string; label: string; method: string; fee_source_id: string | null }>(
    `SELECT id, label, method, fee_source_id FROM classifications
     WHERE event_id = $1 AND user_id = $2 AND superseded_at IS NULL AND source IS NULL
       AND (shape IS NULL OR shape = 'single')`,
    [eventId, source.user_id],
  )).rows;
  if (active.length !== 1) return;
  const a = active[0];
  if (a.label === result.label && a.method === result.method && a.fee_source_id === (result.fee_source_id ?? null)) return;
  await saveManyClassifications([{ event_id: eventId, user_id: source.user_id, ...result, shape: 'single', expected_active_id: a.id }]);
}
