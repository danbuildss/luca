import { query } from '../db.js';
import { fetchAllTransfers, blockToHex } from '../ingestion/alchemy.js';
import { fetchSupportedTokenLogs } from '../ingestion/logs.js';
import { fetchSentTransactions } from '../ingestion/blockscout.js';
import { traceTransaction, type TraceLayer, type TraceResult } from './trace.js';

// Real-wallet check for the roadmap's Phase 1 gate: every transaction any source knows
// for one wallet (Alchemy's transfer feed, the USDC/BNKR token logs, Blockscout's sent
// transactions, and what Luca stored) is traced through every layer, and the losses are
// counted per layer. Read-only: it never writes to the database.

export type WalletAudit = {
  wallet: string;
  wallet_id: string;
  from_block: number;
  to_block: number;
  transactions: number;
  verdicts: Record<TraceResult['verdict'], number>;
  movements: number;
  lost: Array<{ hash: string; layer: TraceLayer; source_key: string; asset: string | null; notes: string[] }>;
  notes: Record<string, number>;
};

export async function auditWallet(
  address: string,
  apiKey: string,
  opts: { pauseMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<WalletAudit> {
  const wallet = address.toLowerCase();
  const w = (await query<{ id: string; from_block: string | null; last_block: string | null }>(
    `SELECT w.id,
            (SELECT MIN(sr.from_block) FROM sync_runs sr WHERE sr.wallet_id = w.id)::text AS from_block,
            wj.last_block::text AS last_block
     FROM wallets w LEFT JOIN watch_jobs wj ON wj.wallet_id = w.id
     WHERE LOWER(w.address) = $1 AND w.chain = 'base'
     ORDER BY w.active DESC, w.created_at ASC
     LIMIT 1`,
    [wallet],
  )).rows[0];
  if (!w) throw new Error(`${address} is not a wallet Luca tracks`);
  if (!w.from_block || !w.last_block) throw new Error(`${address} has not been synced yet`);
  const fromBlock = Number(w.from_block);
  const toBlock = Number(w.last_block);

  // Every source's view of the wallet's history over the range Luca has synced
  const [feed, logs, sent, stored] = await Promise.all([
    fetchAllTransfers(apiKey, wallet, blockToHex(fromBlock), blockToHex(toBlock)),
    fetchSupportedTokenLogs(apiKey, wallet, fromBlock, toBlock),
    fetchSentTransactions(wallet, fromBlock, toBlock),
    query<{ hash: string }>(
      `SELECT DISTINCT LOWER(hash) AS hash FROM normalized_events
       WHERE wallet_id = $1 AND block_number BETWEEN $2 AND $3
       UNION
       SELECT DISTINCT LOWER(tx_hash) FROM raw_receipts
       WHERE wallet_id = $1 AND block_number BETWEEN $2 AND $3`,
      [w.id, fromBlock, toBlock],
    ),
  ]);
  const hashes = [...new Set([
    ...feed.map((t) => t.hash.toLowerCase()),
    ...logs.filter((l) => l.raw > 0n).map((l) => l.hash.toLowerCase()),
    ...sent.map((t) => t.hash.toLowerCase()),
    ...stored.rows.map((r) => r.hash),
  ])].sort();

  const audit: WalletAudit = {
    wallet, wallet_id: w.id, from_block: fromBlock, to_block: toBlock, transactions: hashes.length,
    verdicts: { complete: 0, gaps: 0, not_tracked: 0, not_found: 0 },
    movements: 0, lost: [], notes: {},
  };

  let done = 0;
  for (const hash of hashes) {
    const trace = await traceTransaction(hash, apiKey);
    audit.verdicts[trace.verdict]++;
    for (const m of trace.movements.filter((x) => x.wallet_id === w.id)) {
      audit.movements++;
      if (m.lost_at) audit.lost.push({ hash, layer: m.lost_at, source_key: m.source_key, asset: m.asset, notes: m.notes });
      for (const n of m.notes) audit.notes[n] = (audit.notes[n] ?? 0) + 1;
    }
    opts.onProgress?.(++done, hashes.length);
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  return audit;
}

export function describeAudit(a: WalletAudit): string[] {
  const lines = [
    `Wallet ${a.wallet}, blocks ${a.from_block}–${a.to_block}`,
    `${a.transactions} transactions known to any source, ${a.movements} movements for this wallet.`,
    `Complete: ${a.verdicts.complete}  |  With gaps: ${a.verdicts.gaps}  |  Not found: ${a.verdicts.not_found}  |  Not this wallet's: ${a.verdicts.not_tracked}`,
  ];
  if (a.lost.length === 0) {
    lines.push('', 'Nothing was lost: every movement reached the books.');
  } else {
    const byLayer = new Map<string, number>();
    for (const l of a.lost) byLayer.set(l.layer, (byLayer.get(l.layer) ?? 0) + 1);
    lines.push('', 'Lost movements by layer:', ...[...byLayer].map(([layer, n]) => `  ${layer}: ${n}`));
    lines.push('', 'Details:');
    for (const l of a.lost) {
      lines.push(`  ${l.hash} ${l.source_key} ${l.asset ?? '?'} lost at ${l.layer}${l.notes.length ? ` (${l.notes.join('; ')})` : ''}`);
    }
  }
  const notes = Object.entries(a.notes);
  if (notes.length > 0) {
    lines.push('', 'Notes (not losses):', ...notes.map(([n, c]) => `  ${c} × ${n}`));
  }
  return lines;
}
