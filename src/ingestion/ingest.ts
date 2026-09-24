import { pool, query } from '../db.js';
import { logger } from '../logger.js';
import { touchUserActivation } from '../ops/db.js';
import {
  fetchAllTransfers,
  getCurrentBlock,
  getBlock,
  blockToHex,
  BLOCKS_30_DAYS,
  type TxReceipt,
} from './alchemy.js';
import { fetchSupportedTokenLogs, normalizeTokenLog } from './logs.js';
import { fetchGasItems, fetchGasItemsForBlock } from './gas.js';
import { normalizeTransfer } from './normalize.js';
import {
  fetchTokenTransfers,
  fetchNativeTransactions,
  normalizeTokenTransfer,
  normalizeNativeTx,
} from './blockscout.js';
import { snapshotBalances } from './snapshot.js';
import { enrichUsdValue } from './price.js';
import type { TxRow, EventRow } from './normalize.js';

// Alchemy's transfer index trails eth_blockNumber by a few seconds, so each sync stops
// short of the tip and re-reads a window behind the cursor. Re-reads are idempotent.
export const TIP_LAG_BLOCKS = 10;
export const OVERLAP_BLOCKS = 300;

export type WatchJobRow = {
  id: string;
  user_id: string;
  wallet_id: string;
  last_synced_at: Date | null;
  last_block: string | null; // pg returns BIGINT as string
  wallet_address: string;
};

export async function getActiveWatchJobs(): Promise<WatchJobRow[]> {
  const res = await query<WatchJobRow>(
    `SELECT wj.id, wj.user_id, wj.wallet_id, wj.last_synced_at, wj.last_block,
            w.address AS wallet_address
     FROM watch_jobs wj
     JOIN wallets w ON w.id = wj.wallet_id
     WHERE (
       wj.status = 'active'
       OR (wj.status = 'error' AND wj.updated_at < NOW() - INTERVAL '5 minutes')
     )
       AND w.chain = 'base' AND w.active = TRUE`,
  );
  return res.rows;
}

export function scanWindow(
  lastBlock: string | null,
  currentBlock: number,
): { fromBlock: number; toBlock: number; isBackfill: boolean } | null {
  const toBlock = currentBlock - TIP_LAG_BLOCKS;
  if (lastBlock === null) {
    return { fromBlock: Math.max(0, toBlock - BLOCKS_30_DAYS), toBlock, isBackfill: true };
  }
  const last = parseInt(lastBlock, 10);
  if (last >= toBlock) return null;
  return { fromBlock: Math.max(0, last + 1 - OVERLAP_BLOCKS), toBlock, isBackfill: false };
}

// Fetch transfers via Alchemy (primary) with Blockscout fallback
async function fetchTransfers(
  walletAddress: string,
  fromBlock: number,
  toBlock: number,
  apiKey: string | undefined,
): Promise<{ pairs: Array<{ tx: TxRow; event: EventRow }>; provider: string }> {
  if (apiKey) {
    try {
      const transfers = await fetchAllTransfers(apiKey, walletAddress, blockToHex(fromBlock), blockToHex(toBlock));
      // wallet_id / user_id are injected by the caller — return placeholders here
      const pairs = transfers.map((t) => normalizeTransfer(t, walletAddress, '', ''));
      return { pairs, provider: 'alchemy' };
    } catch (err) {
      logger.warn({ err, wallet: walletAddress }, 'Alchemy failed — falling back to Blockscout');
    }
  }

  const [tokens, native] = await Promise.all([
    fetchTokenTransfers(walletAddress, fromBlock),
    fetchNativeTransactions(walletAddress, fromBlock),
  ]);

  const pairs = [
    ...tokens.map((t) => normalizeTokenTransfer(t, walletAddress, '', '')),
    ...native.map((t) => normalizeNativeTx(t, walletAddress, '', '')),
  ];

  return { pairs, provider: 'blockscout' };
}

async function insertOrGetTxId(
  walletId: string,
  hash: string,
  chain: string,
  sql: string,
  params: unknown[],
): Promise<string> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ id: string }>(sql, params);
    if (res.rows.length > 0) return res.rows[0].id;
    // Conflict — row exists already, fetch its id
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM transactions WHERE chain = $1 AND hash = $2 AND wallet_id = $3',
      [chain, hash, walletId],
    );
    return existing.rows[0].id;
  } finally {
    client.release();
  }
}

// Rows ingested before migration 011 without a log index were keyed 'legacy' (one slot
// per tx). When we see the same transfer again, re-key that row instead of inserting a
// duplicate. Matches on counterparties + asset + amount so a different transfer in the
// same tx is inserted as its own row.
async function claimLegacyEvent(event: EventRow): Promise<boolean> {
  const res = await query(
    `UPDATE normalized_events
     SET source_key = $5::text, log_index = COALESCE($6::integer, log_index),
         token_address = $10::text, supported = $11::boolean, asset = $8::text,
         raw_amount = COALESCE(raw_amount, $12::numeric), block_number = COALESCE(block_number, $13::bigint)
     WHERE id = (
       SELECT id FROM normalized_events
       WHERE chain = $1::text AND hash = $2::text AND wallet_id = $3::uuid
         AND source_key = 'legacy'
         AND LOWER(from_address) = LOWER($4::text)
         AND LOWER(COALESCE(to_address, '')) = LOWER(COALESCE($7::text, ''))
         AND asset IS NOT DISTINCT FROM $8::text
         AND (
           (amount IS NULL AND $9::numeric IS NULL)
           OR ABS(amount - $9::numeric) <= 1e-9 * GREATEST(1, ABS($9::numeric))
         )
       LIMIT 1
     )
     AND NOT EXISTS (
       SELECT 1 FROM normalized_events
       WHERE chain = $1::text AND hash = $2::text AND wallet_id = $3::uuid
         AND source_key = $5::text
     )`,
    [
      event.chain, event.hash, event.wallet_id, event.from_address,
      event.source_key, event.log_index, event.to_address, event.asset, event.amount,
      event.token_address, event.supported, event.raw_amount, event.block_number,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

// New transfers are inserted. A re-read of an already stored transfer fills in what earlier
// versions did not record: asset identity (migration 014), exact amount and block (016).
async function insertEvent(txId: string, event: EventRow): Promise<void> {
  if (await claimLegacyEvent(event)) return;
  await query(
    `INSERT INTO normalized_events
       (transaction_id, wallet_id, user_id, chain, hash, log_index, source_key, block_time,
        from_address, to_address, asset, amount, usd_value, price_source, price_at, direction,
        token_address, supported, raw_amount, block_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (chain, hash, wallet_id, source_key) DO UPDATE
       SET token_address = CASE WHEN normalized_events.supported IS NULL
                                THEN EXCLUDED.token_address ELSE normalized_events.token_address END,
           asset = CASE WHEN normalized_events.supported IS NULL
                        THEN EXCLUDED.asset ELSE normalized_events.asset END,
           supported = COALESCE(normalized_events.supported, EXCLUDED.supported),
           raw_amount = COALESCE(normalized_events.raw_amount, EXCLUDED.raw_amount),
           block_number = COALESCE(normalized_events.block_number, EXCLUDED.block_number)
       WHERE normalized_events.supported IS NULL
          OR normalized_events.raw_amount IS NULL
          OR normalized_events.block_number IS NULL`,
    [
      txId, event.wallet_id, event.user_id, event.chain,
      event.hash, event.log_index, event.source_key, event.block_time,
      event.from_address, event.to_address, event.asset,
      event.amount, event.usd_value, event.price_source,
      event.price_at, event.direction,
      event.token_address, event.supported, event.raw_amount, event.block_number,
    ],
  );
}

// Raw evidence: every transfer as observed, spam included; first provider wins.
async function insertRawTransfer(
  event: EventRow,
  provider: string,
  syncRunId: string,
  payload: Record<string, unknown>,
  blockHash: string | null,
): Promise<void> {
  await query(
    `INSERT INTO raw_transfers
       (wallet_id, chain, tx_hash, source_key, block_number, block_hash, category, token_address,
        raw_amount, from_address, to_address, provider, sync_run_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (chain, tx_hash, wallet_id, source_key) DO UPDATE
       SET raw_amount = COALESCE(raw_transfers.raw_amount, EXCLUDED.raw_amount),
           block_number = COALESCE(raw_transfers.block_number, EXCLUDED.block_number),
           block_hash = COALESCE(raw_transfers.block_hash, EXCLUDED.block_hash)`,
    [
      event.wallet_id, event.chain, event.hash, event.source_key, event.block_number, blockHash,
      event.category, event.token_address, event.raw_amount, event.from_address, event.to_address,
      provider, syncRunId, JSON.stringify(payload),
    ],
  );
}

async function insertRawReceipt(walletId: string, r: TxReceipt): Promise<void> {
  await query(
    `INSERT INTO raw_receipts
       (wallet_id, chain, tx_hash, block_number, block_hash, status, from_address, to_address,
        gas_used, effective_gas_price, l1_fee, operator_fee, fee_wei, payload)
     VALUES ($1, 'base', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (chain, tx_hash, wallet_id) DO NOTHING`,
    [
      walletId, r.hash, r.blockNumber, r.blockHash, r.status, r.from, r.to,
      r.gasUsed.toString(), r.effectiveGasPrice.toString(), r.l1Fee.toString(),
      r.operatorFee.toString(), r.fee.toString(), JSON.stringify(r.raw),
    ],
  );
}

// Labels on unsupported tokens are retired (kept in history) so books, alerts and
// quality views never count them.
async function retireUnsupportedLabels(walletId: string): Promise<void> {
  await query(
    `UPDATE classifications c
     SET superseded_at = NOW()
     FROM normalized_events ne
     WHERE c.event_id = ne.id
       AND ne.wallet_id = $1
       AND ne.supported = FALSE
       AND c.superseded_at IS NULL`,
    [walletId],
  );
}

const TX_SQL = `
  INSERT INTO transactions
    (wallet_id, chain, hash, block_number, block_time, from_address, to_address,
     asset, amount, usd_value, gas_used, gas_price, gas_usd, direction, tx_type, raw_payload)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
  ON CONFLICT (chain, hash, wallet_id) DO UPDATE SET chain = EXCLUDED.chain
  RETURNING id`;

async function storeItem(tx: TxRow, event: EventRow): Promise<void> {
  const price = await enrichUsdValue(
    { supported: event.supported, symbol: event.asset, tokenAddress: event.token_address },
    event.amount,
    event.block_time,
  );
  const enrichedEvent: EventRow = { ...event, ...price };
  const enrichedTx: TxRow = event.category === 'gas'
    ? { ...tx, gas_usd: price.usd_value }
    : { ...tx, usd_value: price.usd_value };

  const txId = await insertOrGetTxId(tx.wallet_id, enrichedTx.hash, enrichedTx.chain, TX_SQL, [
    enrichedTx.wallet_id, enrichedTx.chain, enrichedTx.hash, enrichedTx.block_number,
    enrichedTx.block_time, enrichedTx.from_address, enrichedTx.to_address,
    enrichedTx.asset, enrichedTx.amount, enrichedTx.usd_value,
    enrichedTx.gas_used, enrichedTx.gas_price, enrichedTx.gas_usd,
    enrichedTx.direction, enrichedTx.tx_type, JSON.stringify(enrichedTx.raw_payload),
  ]);
  if (event.category === 'gas') {
    await query(
      `UPDATE transactions SET gas_used = $2, gas_price = $3, gas_usd = COALESCE($4, gas_usd) WHERE id = $1`,
      [txId, enrichedTx.gas_used, enrichedTx.gas_price, enrichedTx.gas_usd],
    );
  }
  await insertEvent(txId, enrichedEvent);
}

export type WalletRef = { wallet_id: string; user_id: string; wallet_address: string };

export type RangeResult = {
  ingested: number;
  failed: number;
  provider: string;
  // True when the range may be incomplete: Blockscout fallback (misses internal ETH) or a
  // failed cross-check / gas lookup. Degraded ranges are re-read with Alchemy later.
  degraded: boolean;
  logGaps: number;
};

async function blockTimes(apiKey: string, blocks: number[]): Promise<Map<number, Date>> {
  const times = new Map<number, Date>();
  for (const b of new Set(blocks)) {
    const info = await getBlock(apiKey, b);
    if (info) times.set(b, new Date(info.timestamp * 1000));
  }
  return times;
}

// Reads one block range from every source and stores it. Throws only when no transfer
// source is reachable at all.
export async function ingestRange(
  w: WalletRef,
  fromBlock: number,
  toBlock: number,
  apiKey: string | undefined,
  syncRunId: string,
  opts: { gasFromBlock?: boolean } = {},
): Promise<RangeResult> {
  const { pairs, provider } = await fetchTransfers(w.wallet_address, fromBlock, toBlock, apiKey);
  let degraded = provider !== 'alchemy';
  let logGaps = 0;

  type Item = { tx: TxRow; event: EventRow; provider: string; blockHash: string | null; receipt?: TxReceipt };
  const items: Item[] = pairs.map((p) => ({ ...p, provider, blockHash: null }));

  if (apiKey) {
    try {
      const logs = await fetchSupportedTokenLogs(apiKey, w.wallet_address, fromBlock, toBlock);
      const seen = new Set(pairs.map((p) => `${p.event.hash.toLowerCase()}|${p.event.source_key}`));
      const missing = logs.filter((l) => !seen.has(`${l.hash.toLowerCase()}|log:${l.logIndex}`));
      const times = await blockTimes(apiKey, missing.map((l) => l.blockNumber));
      for (const l of missing) {
        const time = times.get(l.blockNumber);
        if (!time) { degraded = true; continue; }
        items.push({ ...normalizeTokenLog(l, w.wallet_address, time), provider: 'logs', blockHash: l.blockHash });
        logGaps++;
      }
      if (logGaps > 0) {
        logger.warn({ wallet_id: w.wallet_id, logGaps, fromBlock, toBlock }, 'Token logs had transfers the transfer feed missed');
      }
    } catch (err) {
      degraded = true;
      logger.warn({ err, wallet_id: w.wallet_id }, 'Token log cross-check failed — range marked degraded');
    }

    try {
      const gas = opts.gasFromBlock
        ? (await Promise.all(
            Array.from({ length: toBlock - fromBlock + 1 }, (_, i) =>
              fetchGasItemsForBlock(apiKey, w.wallet_address, fromBlock + i)),
          )).flat()
        : await fetchGasItems(apiKey, w.wallet_address, fromBlock, toBlock);
      for (const g of gas) {
        items.push({ tx: g.tx, event: g.event, provider: 'alchemy', blockHash: g.receipt.blockHash, receipt: g.receipt });
      }
    } catch (err) {
      degraded = true;
      logger.warn({ err, wallet_id: w.wallet_id }, 'Gas lookup failed — range marked degraded');
    }
  } else {
    degraded = true; // no receipts, logs or block reads without Alchemy
  }

  let ingested = 0;
  let failed = 0;
  for (const item of items) {
    // Inject wallet_id and user_id (normalizers used placeholders)
    const tx: TxRow = { ...item.tx, wallet_id: w.wallet_id };
    const event: EventRow = { ...item.event, wallet_id: w.wallet_id, user_id: w.user_id };
    try {
      if (item.receipt) {
        await insertRawReceipt(w.wallet_id, item.receipt);
        if (item.receipt.fee === 0n) { ingested++; continue; }
      } else {
        await insertRawTransfer(event, item.provider, syncRunId, tx.raw_payload, item.blockHash);
      }
      await storeItem(tx, event);
      ingested++;
    } catch (err) {
      failed++;
      logger.error({ err, hash: tx.hash, wallet_id: w.wallet_id }, 'Failed to store transfer');
    }
  }

  await retireUnsupportedLabels(w.wallet_id);
  return { ingested, failed, provider, degraded, logGaps };
}

// Re-read the oldest degraded range with Alchemy; it is cleared once a re-read is clean.
async function rescanDegradedRange(w: WalletRef, apiKey: string): Promise<void> {
  const res = await query<{ id: string; from_block: string; to_block: string }>(
    `SELECT id, from_block::text, to_block::text FROM sync_runs
     WHERE wallet_id = $1 AND degraded AND rescanned_at IS NULL
       AND from_block IS NOT NULL AND to_block IS NOT NULL AND status <> 'running'
     ORDER BY started_at ASC
     LIMIT 1`,
    [w.wallet_id],
  );
  const run = res.rows[0];
  if (!run) return;
  try {
    const result = await ingestRange(w, Number(run.from_block), Number(run.to_block), apiKey, run.id);
    if (!result.degraded && result.failed === 0) {
      await query(`UPDATE sync_runs SET rescanned_at = NOW() WHERE id = $1`, [run.id]);
      logger.info({ wallet_id: w.wallet_id, run_id: run.id }, 'Degraded range re-read with Alchemy');
    }
  } catch (err) {
    logger.warn({ err, wallet_id: w.wallet_id, run_id: run.id }, 'Degraded range re-read failed');
  }
}

export async function syncWallet(job: WatchJobRow, apiKey: string | undefined): Promise<void> {
  const { wallet_id, user_id, wallet_address, last_block } = job;
  const w: WalletRef = { wallet_id, user_id, wallet_address };

  // Get current tip — use Alchemy if available, else Blockscout isn't block-aware so we
  // derive current block from the latest Blockscout tx (best-effort; Alchemy preferred).
  let currentBlock: number;
  if (apiKey) {
    currentBlock = await getCurrentBlock(apiKey);
  } else {
    // For production, ALCHEMY_API_KEY should always be set
    currentBlock = 999_999_999;
    logger.warn({ wallet_id }, 'No ALCHEMY_API_KEY — using Blockscout only; current block unknown');
  }

  const window = scanWindow(last_block, currentBlock);
  if (!window) {
    logger.debug({ wallet_id, currentBlock }, 'No new blocks — skipping sync');
    if (apiKey) await rescanDegradedRange(w, apiKey);
    return;
  }
  const { fromBlock, toBlock, isBackfill } = window;

  logger.info(
    { wallet_id, wallet_address, fromBlock, toBlock, isBackfill },
    'Starting wallet sync',
  );

  const runRes = await query<{ id: string }>(
    `INSERT INTO sync_runs (wallet_id, provider, chain, started_at, status, from_block, to_block)
     VALUES ($1, 'pending', 'base', NOW(), 'running', $2, $3)
     RETURNING id`,
    [wallet_id, fromBlock, toBlock],
  );
  const syncRunId = runRes.rows[0].id;

  let provider = 'unknown';

  try {
    const result = await ingestRange(w, fromBlock, toBlock, apiKey, syncRunId);
    provider = result.provider;

    // Snapshot balances
    await snapshotBalances(apiKey, wallet_id, user_id, wallet_address);

    // A failed store leaves the cursor in place so the next sync retries the same range.
    // Without Alchemy there is no real block number to advance to.
    const advance = result.failed === 0 && Boolean(apiKey);
    await query(
      `UPDATE watch_jobs
       SET last_synced_at = NOW(),
           last_block = CASE WHEN $3 THEN $1::bigint ELSE last_block END,
           status = 'active', updated_at = NOW()
       WHERE id = $2`,
      [toBlock, job.id, advance],
    );

    await query(
      `UPDATE sync_runs
       SET status = $4, completed_at = NOW(), events_ingested = $1, provider = $2, failed_count = $5,
           degraded = $6, log_gaps = $7
       WHERE id = $3`,
      [
        result.ingested, provider, syncRunId, result.failed === 0 ? 'completed' : 'partial',
        result.failed, result.degraded, result.logGaps,
      ],
    );

    // Set activated_at on first successful sync (idempotent — only sets if null)
    if (isBackfill || result.ingested > 0) {
      void touchUserActivation(user_id);
    }

    logger.info(
      { wallet_id, ingested: result.ingested, failed: result.failed, provider, toBlock, degraded: result.degraded },
      'Wallet sync complete',
    );
  } catch (err) {
    await query(
      `UPDATE watch_jobs SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [String(err), job.id],
    );
    await query(
      `UPDATE sync_runs
       SET status = 'failed', completed_at = NOW(), error_message = $1, provider = $2
       WHERE id = $3`,
      [String(err), provider, syncRunId],
    );
    throw err;
  }

  if (apiKey) await rescanDegradedRange(w, apiKey);
}
