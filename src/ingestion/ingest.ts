import { pool, query } from '../db.js';
import { logger } from '../logger.js';
import {
  fetchAllTransfers,
  getCurrentBlock,
  backfillFromBlock,
  blockToHex,
  BLOCKS_30_DAYS,
} from './alchemy.js';
import { normalizeTransfer } from './normalize.js';
import { snapshotBalances } from './snapshot.js';

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
     WHERE wj.status = 'active' AND w.chain = 'base' AND w.active = TRUE`,
  );
  return res.rows;
}

async function insertOrGetTxId(
  walletId: string,
  hash: string,
  chain: string,
  params: unknown[],
  sql: string,
): Promise<string> {
  // Try insert; on conflict return existing id
  const client = await pool.connect();
  try {
    const res = await client.query<{ id: string }>(sql, params);
    if (res.rows.length > 0) return res.rows[0].id;
    // Conflict — row already exists, fetch it
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM transactions WHERE chain = $1 AND hash = $2 AND wallet_id = $3',
      [chain, hash, walletId],
    );
    return existing.rows[0].id;
  } finally {
    client.release();
  }
}

export async function syncWallet(job: WatchJobRow, apiKey: string): Promise<void> {
  const { wallet_id, user_id, wallet_address, last_block } = job;

  // Determine sync range
  const currentBlock = await getCurrentBlock(apiKey);
  const isBackfill = last_block === null;
  const fromBlock = isBackfill
    ? backfillFromBlock(currentBlock)
    : blockToHex(parseInt(last_block, 10) + 1);
  const toBlock = blockToHex(currentBlock);

  if (!isBackfill && parseInt(last_block, 10) >= currentBlock) {
    logger.debug({ wallet_id, currentBlock }, 'No new blocks — skipping sync');
    return;
  }

  logger.info(
    { wallet_id, wallet_address, fromBlock, toBlock, isBackfill, lookback: isBackfill ? BLOCKS_30_DAYS : undefined },
    'Starting wallet sync',
  );

  // Record sync run
  const runRes = await query<{ id: string }>(
    `INSERT INTO sync_runs (wallet_id, provider, chain, started_at, status)
     VALUES ($1, 'alchemy', 'base', NOW(), 'running')
     RETURNING id`,
    [wallet_id],
  );
  const syncRunId = runRes.rows[0].id;

  let ingested = 0;
  let failed = 0;

  try {
    const transfers = await fetchAllTransfers(apiKey, wallet_address, fromBlock, toBlock);

    for (const t of transfers) {
      try {
        const { tx, event } = normalizeTransfer(t, wallet_address, wallet_id, user_id);

        // Insert transaction (idempotent — return existing id on conflict)
        const txSql = `
          INSERT INTO transactions
            (wallet_id, chain, hash, block_number, block_time, from_address, to_address,
             asset, amount, usd_value, gas_used, gas_price, gas_usd, direction, tx_type, raw_payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (chain, hash, wallet_id) DO UPDATE SET chain = EXCLUDED.chain
          RETURNING id`;
        const txParams = [
          tx.wallet_id, tx.chain, tx.hash, tx.block_number, tx.block_time,
          tx.from_address, tx.to_address, tx.asset, tx.amount, tx.usd_value,
          tx.gas_used, tx.gas_price, tx.gas_usd, tx.direction, tx.tx_type,
          JSON.stringify(tx.raw_payload),
        ];

        const txId = await insertOrGetTxId(wallet_id, tx.hash, tx.chain, txParams, txSql);

        // Insert normalized event (idempotent)
        await query(
          `INSERT INTO normalized_events
             (transaction_id, wallet_id, user_id, chain, hash, log_index, block_time,
              from_address, to_address, asset, amount, usd_value, price_source, price_at, direction)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (chain, hash, wallet_id, COALESCE(log_index, -1)) DO NOTHING`,
          [
            txId, event.wallet_id, event.user_id, event.chain, event.hash,
            event.log_index, event.block_time, event.from_address, event.to_address,
            event.asset, event.amount, event.usd_value, event.price_source,
            event.price_at, event.direction,
          ],
        );

        ingested++;
      } catch (err) {
        failed++;
        logger.error({ err, hash: t.hash, wallet_id }, 'Failed to store transfer');
      }
    }

    // Snapshot balances after sync
    await snapshotBalances(apiKey, wallet_id, user_id, wallet_address);

    // Advance the cursor
    await query(
      `UPDATE watch_jobs SET last_synced_at = NOW(), last_block = $1, status = 'active', updated_at = NOW()
       WHERE id = $2`,
      [currentBlock, job.id],
    );

    // Mark sync run complete
    await query(
      `UPDATE sync_runs SET status = 'completed', completed_at = NOW(), events_ingested = $1
       WHERE id = $2`,
      [ingested, syncRunId],
    );

    logger.info({ wallet_id, ingested, failed, currentBlock }, 'Wallet sync complete');
  } catch (err) {
    await query(
      `UPDATE watch_jobs SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [String(err), job.id],
    );
    await query(
      `UPDATE sync_runs SET status = 'failed', completed_at = NOW(), error_message = $1 WHERE id = $2`,
      [String(err), syncRunId],
    );
    throw err;
  }
}
