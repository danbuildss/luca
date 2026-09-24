import { query } from '../db.js';
import { logger } from '../logger.js';
import { getEthBalanceAt, getErc20BalanceAt, getBlock } from '../ingestion/alchemy.js';
import { BASE_USDC, BASE_BNKR } from '../ingestion/assets.js';
import { ingestRange, type WalletRef } from '../ingestion/ingest.js';
import { formatAddress } from '../telegram/format.js';

// Every hour, per wallet and asset, prove the ledger against the chain:
//   on-chain balance at B2 = on-chain balance at the last checkpoint
//                            + recorded ins - outs (- fees, for ETH) in between
// exactly, in the smallest unit. When it does not add up, bisect to the block where the
// chain moved without the ledger, re-read that block from every source, and check again.

export const RECONCILE_INTERVAL_MINUTES = 60;
export const MAX_REPAIRS_PER_ASSET = 10;

type Asset = { symbol: 'ETH' | 'USDC' | 'BNKR'; token: string | null };
export const LEDGER_ASSETS: Asset[] = [
  { symbol: 'ETH', token: null },
  { symbol: 'USDC', token: BASE_USDC },
  { symbol: 'BNKR', token: BASE_BNKR },
];

export type ReconcileWallet = WalletRef & { job_id: string; last_block: string | null };

type AssetOutcome =
  | { asset: string; status: 'ok' | 'repaired' }
  | { asset: string; status: 'drift'; driftBlock: number };

async function onchainBalance(apiKey: string, address: string, asset: Asset, block: number): Promise<bigint> {
  return asset.token
    ? getErc20BalanceAt(apiKey, address, asset.token, block)
    : getEthBalanceAt(apiKey, address, block);
}

// Net recorded change in (fromBlock, toBlock]. Transfers inside a transaction that failed
// did not happen; ETH also pays every fee the wallet's own transactions cost.
export async function ledgerDelta(
  w: WalletRef,
  asset: Asset,
  fromBlock: number,
  toBlock: number,
): Promise<bigint> {
  const assetFilter = asset.token
    ? `rt.token_address = $5`
    : `rt.token_address IS NULL AND rt.category IN ('external', 'internal')`;
  const params: unknown[] = [w.wallet_id, fromBlock, toBlock, w.wallet_address.toLowerCase()];
  if (asset.token) params.push(asset.token);

  const moved = await query<{ delta: string }>(
    `SELECT (COALESCE(SUM(CASE WHEN LOWER(rt.to_address) = $4 THEN rt.raw_amount ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN LOWER(rt.from_address) = $4 THEN rt.raw_amount ELSE 0 END), 0))::text AS delta
     FROM raw_transfers rt
     WHERE rt.wallet_id = $1 AND rt.block_number > $2 AND rt.block_number <= $3
       AND ${assetFilter}
       AND NOT EXISTS (
         SELECT 1 FROM raw_receipts rr
         WHERE LOWER(rr.tx_hash) = LOWER(rt.tx_hash) AND rr.status = 'failed'
       )`,
    params,
  );
  let delta = BigInt(moved.rows[0]?.delta ?? '0');

  if (!asset.token) {
    const fees = await query<{ fees: string }>(
      `SELECT COALESCE(SUM(fee_wei), 0)::text AS fees FROM raw_receipts
       WHERE wallet_id = $1 AND block_number > $2 AND block_number <= $3`,
      [w.wallet_id, fromBlock, toBlock],
    );
    delta -= BigInt(fees.rows[0]?.fees ?? '0');
  }
  return delta;
}

async function getCheckpoint(walletId: string, asset: string): Promise<{ block: number; balance: bigint } | null> {
  const res = await query<{ block_number: string; balance_raw: string }>(
    `SELECT block_number::text, balance_raw::text FROM ledger_checkpoints WHERE wallet_id = $1 AND asset = $2`,
    [walletId, asset],
  );
  const r = res.rows[0];
  return r ? { block: Number(r.block_number), balance: BigInt(r.balance_raw) } : null;
}

async function saveCheckpoint(walletId: string, asset: string, block: number, balance: bigint): Promise<void> {
  await query(
    `INSERT INTO ledger_checkpoints (wallet_id, asset, block_number, balance_raw, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (wallet_id, asset) DO UPDATE
       SET block_number = EXCLUDED.block_number, balance_raw = EXCLUDED.balance_raw, updated_at = NOW()`,
    [walletId, asset, block, balance.toString()],
  );
}

async function recordRun(params: {
  walletId: string; asset: string; fromBlock: number; toBlock: number;
  expected: bigint | null; actual: bigint | null; status: 'ok' | 'repaired' | 'drift' | 'error';
  driftBlock?: number | null; details?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO reconciliation_runs
       (wallet_id, asset, from_block, to_block, expected_raw, actual_raw, status, drift_block, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      params.walletId, params.asset, params.fromBlock, params.toBlock,
      params.expected?.toString() ?? null, params.actual?.toString() ?? null,
      params.status, params.driftBlock ?? null, params.details ? JSON.stringify(params.details) : null,
    ],
  );
}

// Where history starts: one block before the wallet's first recorded activity.
async function openingBlock(walletId: string, fallback: number): Promise<number> {
  const res = await query<{ first: string | null }>(
    `SELECT LEAST(
       (SELECT MIN(block_number) FROM raw_transfers WHERE wallet_id = $1),
       (SELECT MIN(block_number) FROM raw_receipts WHERE wallet_id = $1)
     )::text AS first`,
    [walletId],
  );
  const first = res.rows[0]?.first;
  return first != null ? Math.min(Number(first) - 1, fallback) : fallback;
}

async function repairBlock(w: WalletRef, apiKey: string, block: number): Promise<void> {
  const run = await query<{ id: string }>(
    `INSERT INTO sync_runs (wallet_id, provider, chain, started_at, status, from_block, to_block)
     VALUES ($1, 'repair', 'base', NOW(), 'running', $2, $2)
     RETURNING id`,
    [w.wallet_id, block],
  );
  const runId = run.rows[0].id;
  try {
    const result = await ingestRange(w, block, block, apiKey, runId, { gasFromBlock: true });
    await query(
      `UPDATE sync_runs SET status = $2, completed_at = NOW(), events_ingested = $3,
              failed_count = $4, degraded = $5, log_gaps = $6
       WHERE id = $1`,
      [runId, result.failed === 0 ? 'completed' : 'partial', result.ingested, result.failed,
        result.degraded, result.logGaps],
    );
  } catch (err) {
    await query(
      `UPDATE sync_runs SET status = 'failed', completed_at = NOW(), error_message = $2 WHERE id = $1`,
      [runId, String(err)],
    );
    throw err;
  }
}

async function reconcileAsset(
  w: ReconcileWallet,
  apiKey: string,
  asset: Asset,
  toBlock: number,
): Promise<AssetOutcome> {
  let cp = await getCheckpoint(w.wallet_id, asset.symbol);
  if (!cp) {
    const opening = await openingBlock(w.wallet_id, toBlock);
    cp = { block: opening, balance: await onchainBalance(apiKey, w.wallet_address, asset, opening) };
    await saveCheckpoint(w.wallet_id, asset.symbol, cp.block, cp.balance);
  }
  if (cp.block >= toBlock) return { asset: asset.symbol, status: 'ok' };

  const base = cp;
  const expectedAt = async (block: number): Promise<bigint> =>
    base.balance + await ledgerDelta(w, asset, base.block, block);

  const actual = await onchainBalance(apiKey, w.wallet_address, asset, toBlock);
  let expected = await expectedAt(toBlock);
  if (expected === actual) {
    await saveCheckpoint(w.wallet_id, asset.symbol, toBlock, actual);
    await recordRun({ walletId: w.wallet_id, asset: asset.symbol, fromBlock: base.block, toBlock, expected, actual, status: 'ok' });
    return { asset: asset.symbol, status: 'ok' };
  }

  // Narrows (from, to] to the first block where the ledger stops matching the chain:
  // returns it as `bad` and the block just before it as `good`. The caller guarantees the
  // ledger matches at `from` and not at `to`.
  const firstMismatch = async (from: number, to: number): Promise<{ good: number; bad: number }> => {
    let good = from;
    let bad = to;
    while (bad - good > 1) {
      const mid = Math.floor((good + bad) / 2);
      if (await onchainBalance(apiKey, w.wallet_address, asset, mid) === await expectedAt(mid)) good = mid;
      else bad = mid;
    }
    return { good, bad };
  };

  const repaired: number[] = [];
  let { good: lo, bad: hi } = await firstMismatch(base.block, toBlock);
  for (let attempt = 0; attempt < MAX_REPAIRS_PER_ASSET; attempt++) {
    const before = await expectedAt(toBlock);
    await repairBlock(w, apiKey, hi);
    repaired.push(hi);
    expected = await expectedAt(toBlock);

    if (expected === actual) {
      await saveCheckpoint(w.wallet_id, asset.symbol, toBlock, actual);
      await recordRun({
        walletId: w.wallet_id, asset: asset.symbol, fromBlock: base.block, toBlock,
        expected, actual, status: 'repaired', details: { repaired_blocks: repaired },
      });
      logger.info({ wallet_id: w.wallet_id, asset: asset.symbol, repaired }, 'Ledger gap repaired');
      return { asset: asset.symbol, status: 'repaired' };
    }
    // The re-read found nothing new at this block: hi is the unexplained change.
    if (expected === before) break;
    // Something was recovered. If this block now adds up, look for the next gap after it.
    if (await onchainBalance(apiKey, w.wallet_address, asset, hi) === await expectedAt(hi)) {
      ({ good: lo, bad: hi } = await firstMismatch(hi, toBlock));
    }
  }

  // Everything up to lo is proven; keep that progress and flag the gap at hi.
  const provenBalance = await expectedAt(lo);
  await saveCheckpoint(w.wallet_id, asset.symbol, lo, provenBalance);
  await recordRun({
    walletId: w.wallet_id, asset: asset.symbol, fromBlock: base.block, toBlock,
    expected, actual, status: 'drift', driftBlock: hi,
    details: { repaired_blocks: repaired, unexplained_raw: (actual - expected).toString() },
  });
  logger.warn({ wallet_id: w.wallet_id, asset: asset.symbol, driftBlock: hi }, 'Ledger gap could not be repaired');
  return { asset: asset.symbol, status: 'drift', driftBlock: hi };
}

async function markIncomplete(w: ReconcileWallet, apiKey: string, driftBlock: number): Promise<void> {
  const block = await getBlock(apiKey, driftBlock).catch(() => null);
  const since = block ? new Date(block.timestamp * 1000) : null;
  const prev = await query<{ ledger_status: string; incomplete_since_block: string | null }>(
    `SELECT ledger_status, incomplete_since_block::text FROM watch_jobs WHERE id = $1`,
    [w.job_id],
  );
  await query(
    `UPDATE watch_jobs
     SET ledger_status = 'incomplete', incomplete_since_block = $2, incomplete_since_at = $3,
         last_reconciled_at = NOW()
     WHERE id = $1`,
    [w.job_id, driftBlock, since],
  );

  const already = prev.rows[0]?.ledger_status === 'incomplete'
    && prev.rows[0]?.incomplete_since_block === String(driftBlock);
  if (already) return;

  const when = since ? since.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : `block ${driftBlock}`;
  await query(
    `INSERT INTO alerts (user_id, type, message, evidence, dedup_key)
     VALUES ($1, 'ledger_incomplete', $2, $3, $4)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [
      w.user_id,
      [
        'Your books may be missing something',
        `The balance of ${formatAddress(w.wallet_address)} changed on ${when} in a way I cannot match to a recorded transaction yet. I am looking into it and will keep checking.`,
      ].join('\n'),
      JSON.stringify({ wallet_id: w.wallet_id, drift_block: driftBlock }),
      `ledger_incomplete:${w.wallet_id}:${driftBlock}`,
    ],
  );
}

export async function reconcileWallet(w: ReconcileWallet, apiKey: string): Promise<AssetOutcome[]> {
  if (w.last_block === null) return [];
  const toBlock = Number(w.last_block);

  const outcomes: AssetOutcome[] = [];
  for (const asset of LEDGER_ASSETS) {
    try {
      outcomes.push(await reconcileAsset(w, apiKey, asset, toBlock));
    } catch (err) {
      logger.warn({ err, wallet_id: w.wallet_id, asset: asset.symbol }, 'Balance check failed');
      await recordRun({
        walletId: w.wallet_id, asset: asset.symbol, fromBlock: toBlock, toBlock,
        expected: null, actual: null, status: 'error', details: { error: String(err) },
      }).catch(() => undefined);
      // A provider error proves nothing either way: keep the ledger status, retry next hour.
      await query(`UPDATE watch_jobs SET last_reconciled_at = NOW() WHERE id = $1`, [w.job_id]);
      return outcomes;
    }
  }

  const drifts = outcomes.filter((o): o is Extract<AssetOutcome, { status: 'drift' }> => o.status === 'drift');
  if (drifts.length > 0) {
    await markIncomplete(w, apiKey, Math.min(...drifts.map((d) => d.driftBlock)));
  } else {
    await query(
      `UPDATE watch_jobs
       SET ledger_status = 'complete', incomplete_since_block = NULL, incomplete_since_at = NULL,
           last_reconciled_at = NOW()
       WHERE id = $1`,
      [w.job_id],
    );
  }
  return outcomes;
}

export async function getWalletsDueForReconciliation(): Promise<ReconcileWallet[]> {
  const res = await query<ReconcileWallet>(
    `SELECT wj.id AS job_id, wj.wallet_id, wj.user_id, w.address AS wallet_address, wj.last_block::text AS last_block
     FROM watch_jobs wj
     JOIN wallets w ON w.id = wj.wallet_id
     WHERE w.active = TRUE AND w.chain = 'base'
       AND wj.last_block IS NOT NULL
       AND (wj.last_reconciled_at IS NULL
            OR wj.last_reconciled_at < NOW() - ($1::int * INTERVAL '1 minute'))`,
    [RECONCILE_INTERVAL_MINUTES],
  );
  return res.rows;
}

export async function reconcileDueWallets(apiKey: string): Promise<void> {
  for (const w of await getWalletsDueForReconciliation()) {
    try {
      await reconcileWallet(w, apiKey);
    } catch (err) {
      logger.error({ err, wallet_id: w.wallet_id }, 'Reconciliation failed');
    }
  }
}
