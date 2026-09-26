import { query } from '../db.js';
import { fetchAllTransfers, blockToHex, getCurrentBlock, RpcError } from '../ingestion/alchemy.js';
import { fetchSupportedTokenLogs } from '../ingestion/logs.js';
import { fetchSentTransactions } from '../ingestion/blockscout.js';
import { traceTransaction, type TraceLayer, type TraceResult } from './trace.js';

// Real-wallet check for the roadmap's Phase 1 gate: every transaction any source knows
// for one wallet over a block range (Alchemy's transfer feed, the USDC/BNKR token logs,
// Blockscout's sent transactions, and what Luca stored) is traced through every layer,
// and what did not reach the books is listed by layer. Read-only: it never writes.

// Base produces a block every 2 seconds
export const BLOCKS_PER_DAY = 43_200;

// A check verifies up to the chain, not up to Luca's own sync, so a stuck or lossy sync
// cannot shrink what gets checked. It stops this far behind the tip: the worker syncs
// every 60 seconds to 10 blocks short of the tip, so anything older than 5 minutes that
// is not in the books is a real miss, not a sync that simply has not run yet. Base
// reorgs are far shallower than this.
export const AUDIT_SAFE_MARGIN_BLOCKS = 150;

export async function safeBlock(apiKey: string): Promise<number> {
  const tip = await getCurrentBlock(apiKey).catch((err: unknown) => { throw new ProviderUnavailableError(err); });
  return tip - AUDIT_SAFE_MARGIN_BLOCKS;
}

// A data provider (Alchemy, Blockscout) did not answer; the check could not finish.
export class ProviderUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(`data provider unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function isProviderError(err: unknown): boolean {
  const e = err as { isAxiosError?: boolean; code?: string } | null;
  return err instanceof RpcError || Boolean(e?.isAxiosError)
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(e?.code ?? '');
}

// Provider failures become ProviderUnavailableError; anything else (a bug, the database)
// propagates as itself so it is not mistaken for an outage.
async function fromProvider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw isProviderError(err) ? new ProviderUnavailableError(err) : err;
  }
}

export type AuditItem = {
  hash: string;
  block: number | null;
  source_key: string;
  asset: string | null;
  direction: 'in' | 'out' | null;
  raw_amount: string | null;
};

export type WalletAudit = {
  wallet: string;
  wallet_id: string;
  from_block: number;
  to_block: number;
  // How far Luca's own sync of the wallet had got (watch_jobs.last_block)
  synced_to: number | null;
  // Every transaction any source knew for the wallet, spam included
  discovered: number;
  // Transactions with at least one ETH, USDC or BNKR movement for this wallet
  transactions: number;
  hashes: string[];
  verdicts: Record<TraceResult['verdict'], number>;
  movements: number;
  lost: Array<AuditItem & { layer: TraceLayer; notes: string[] }>;
  // In the books, labeled unknown: waiting on the operator, not missing
  unknown: AuditItem[];
  notes: Record<string, number>;
};

export type WalletRange = {
  wallet_id: string; address: string; from_block: number; to_block: number; synced_to: number | null;
};

// What a check covers for a wallet: from the first block Luca ever synced for it (or the
// last `days`) up to `toBlock`, normally the safe chain block. Null when never synced.
export async function auditableRange(walletId: string, toBlock: number, days?: number | null): Promise<WalletRange | null> {
  const w = (await query<{ id: string; address: string; from_block: string | null; last_block: string | null }>(
    `SELECT w.id, LOWER(w.address) AS address,
            (SELECT MIN(sr.from_block) FROM sync_runs sr WHERE sr.wallet_id = w.id)::text AS from_block,
            wj.last_block::text AS last_block
     FROM wallets w LEFT JOIN watch_jobs wj ON wj.wallet_id = w.id
     WHERE w.id = $1`,
    [walletId],
  )).rows[0];
  if (!w?.from_block) return null;
  let fromBlock = Number(w.from_block);
  if (days) fromBlock = Math.max(fromBlock, toBlock - days * BLOCKS_PER_DAY);
  return {
    wallet_id: w.id, address: w.address, from_block: fromBlock, to_block: toBlock,
    synced_to: w.last_block ? Number(w.last_block) : null,
  };
}

export async function auditRange(
  range: WalletRange,
  apiKey: string,
  opts: { pauseMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<WalletAudit> {
  const { wallet_id, address: wallet, from_block: fromBlock, to_block: toBlock } = range;

  // Every source's view of the wallet's history over the range. These calls only talk to
  // the providers, so any failure here means a provider did not answer.
  const [feed, logs, sent] = await Promise.all([
    fetchAllTransfers(apiKey, wallet, blockToHex(fromBlock), blockToHex(toBlock)),
    fetchSupportedTokenLogs(apiKey, wallet, fromBlock, toBlock),
    fetchSentTransactions(wallet, fromBlock, toBlock),
  ]).catch((err: unknown) => { throw new ProviderUnavailableError(err); });
  const stored = await query<{ hash: string }>(
    `SELECT DISTINCT LOWER(hash) AS hash FROM normalized_events
     WHERE wallet_id = $1 AND block_number BETWEEN $2 AND $3
     UNION
     SELECT DISTINCT LOWER(tx_hash) FROM raw_receipts
     WHERE wallet_id = $1 AND block_number BETWEEN $2 AND $3`,
    [wallet_id, fromBlock, toBlock],
  );
  const hashes = [...new Set([
    ...feed.map((t) => t.hash.toLowerCase()),
    ...logs.filter((l) => l.raw > 0n).map((l) => l.hash.toLowerCase()),
    ...sent.map((t) => t.hash.toLowerCase()),
    ...stored.rows.map((r) => r.hash),
  ])].sort();

  const audit: WalletAudit = {
    wallet, wallet_id, from_block: fromBlock, to_block: toBlock, synced_to: range.synced_to,
    discovered: hashes.length, transactions: 0, hashes: [],
    verdicts: { complete: 0, gaps: 0, not_tracked: 0, not_found: 0 },
    movements: 0, lost: [], unknown: [], notes: {},
  };

  let done = 0;
  for (const hash of hashes) {
    const trace = await fromProvider(() => traceTransaction(hash, apiKey));
    audit.verdicts[trace.verdict]++;
    let counted = false;
    for (const m of trace.movements.filter((x) => x.wallet_id === wallet_id)) {
      // Spam and other untracked tokens are not part of the books unless something went wrong
      if (!['ETH', 'USDC', 'BNKR'].includes(m.asset ?? '') && !m.lost_at) continue;
      counted = true;
      audit.movements++;
      const item: AuditItem = {
        hash, block: trace.block, source_key: m.source_key, asset: m.asset, direction: m.direction, raw_amount: m.raw_amount,
      };
      if (m.lost_at) audit.lost.push({ ...item, layer: m.lost_at, notes: m.notes });
      else if (m.label_status === 'unknown') audit.unknown.push(item);
      for (const n of m.notes) audit.notes[n] = (audit.notes[n] ?? 0) + 1;
    }
    if (counted) { audit.transactions++; audit.hashes.push(hash); }
    opts.onProgress?.(++done, hashes.length);
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  return audit;
}

// Engineering fallback: the server script audits one wallet by address
export async function auditWallet(
  address: string,
  apiKey: string,
  opts: { days?: number; pauseMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<WalletAudit> {
  const w = (await query<{ id: string }>(
    `SELECT id FROM wallets WHERE LOWER(address) = $1 AND chain = 'base'
     ORDER BY active DESC, created_at ASC LIMIT 1`,
    [address.toLowerCase()],
  )).rows[0];
  if (!w) throw new Error(`${address} is not a wallet Luca tracks`);
  const range = await auditableRange(w.id, await safeBlock(apiKey), opts.days);
  if (!range) throw new Error(`${address} has not been synced yet`);
  return auditRange(range, apiKey, opts);
}

export function describeAudit(a: WalletAudit): string[] {
  const lines = [
    `Wallet ${a.wallet}, blocks ${a.from_block}–${a.to_block} (Luca's sync is at ${a.synced_to ?? 'never'})`,
    `${a.discovered} transactions known to any source; ${a.transactions} with ETH, USDC or BNKR movements (${a.movements} movements).`,
    `Complete: ${a.verdicts.complete}  |  With gaps: ${a.verdicts.gaps}  |  Not found: ${a.verdicts.not_found}  |  Not this wallet's: ${a.verdicts.not_tracked}`,
    `Labeled unknown (waiting on the operator, not missing): ${a.unknown.length}`,
  ];
  if (a.lost.length === 0) {
    lines.push('', 'Nothing was lost: every supported movement reached the books.');
  } else {
    const byLayer = new Map<string, number>();
    for (const l of a.lost) byLayer.set(l.layer, (byLayer.get(l.layer) ?? 0) + 1);
    lines.push('', 'Did not reach the books, by layer:', ...[...byLayer].map(([layer, n]) => `  ${layer}: ${n}`));
    lines.push('', 'Details:');
    for (const l of a.lost) {
      lines.push(`  ${l.hash} ${l.source_key} ${l.asset ?? '?'} stopped at ${l.layer}${l.notes.length ? ` (${l.notes.join('; ')})` : ''}`);
    }
  }
  const notes = Object.entries(a.notes);
  if (notes.length > 0) {
    lines.push('', 'Notes (not losses):', ...notes.map(([n, c]) => `  ${c} × ${n}`));
  }
  return lines;
}
