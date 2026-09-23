import { pool, query } from '../db.js';
import { logger } from '../logger.js';
import {
  fetchAllTransfers,
  getCurrentBlock,
  blockToHex,
  BLOCKS_30_DAYS,
} from './alchemy.js';
import { normalizeTransfer } from './normalize.js';
import {
  fetchTokenTransfers,
  fetchNativeTransactions,
  normalizeTokenTransfer,
  normalizeNativeTx,
} from './blockscout.js';
import { snapshotBalances } from './snapshot.js';
import { enrichUsdValue, isTrackedAsset } from './price.js';
import type { TxRow, EventRow } from './normalize.js';

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

// Fetch transfers via Alchemy (primary) with Blockscout fallback
async function fetchTransfers(
  walletAddress: string,
  fromBlock: string,        // hex for Alchemy
  fromBlockNumber: number,  // decimal for Blockscout
  toBlock: string,
  apiKey: string | undefined,
): Promise<{ pairs: Array<{ tx: TxRow; event: EventRow }>; provider: string }> {
  if (apiKey) {
    try {
      const transfers = await fetchAllTransfers(apiKey, walletAddress, fromBlock, toBlock);
      const pairs = transfers.map((t) => normalizeTransfer(t, walletAddress, '', ''));
      // wallet_id / user_id are injected by the caller — return placeholders here
      return { pairs, provider: 'alchemy' };
    } catch (err) {
      logger.warn({ err, wallet: walletAddress }, 'Alchemy failed — falling back to Blockscout');
    }
  }

  // Blockscout fallback
  const [tokens, native] = await Promise.all([
    fetchTokenTransfers(walletAddress, fromBlockNumber),
    fetchNativeTransactions(walletAddress, fromBlockNumber),
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

export async function syncWallet(job: WatchJobRow, apiKey: string | undefined): Promise<void> {
  const { wallet_id, user_id, wallet_address, last_block } = job;

  // Get current tip — use Alchemy if available, else Blockscout isn't block-aware so we
  // derive current block from the latest Blockscout tx (best-effort; Alchemy preferred).
  let currentBlock: number;
  if (apiKey) {
    currentBlock = await getCurrentBlock(apiKey);
  } else {
    // Approximate: Blockscout's tx list gives us the newest block seen
    // We'll use a large sentinel and let the timestamp filter do the work
    // For production, ALCHEMY_API_KEY should always be set
    currentBlock = 999_999_999;
    logger.warn({ wallet_id }, 'No ALCHEMY_API_KEY — using Blockscout only; current block unknown');
  }

  const isBackfill = last_block === null;
  const fromBlockNumber = isBackfill
    ? Math.max(0, currentBlock - BLOCKS_30_DAYS)
    : parseInt(last_block, 10) + 1;
  const fromBlock = blockToHex(fromBlockNumber);
  const toBlock = blockToHex(currentBlock);

  if (!isBackfill && parseInt(last_block, 10) >= currentBlock) {
    logger.debug({ wallet_id, currentBlock }, 'No new blocks — skipping sync');
    return;
  }

  logger.info(
    { wallet_id, wallet_address, fromBlockNumber, currentBlock, isBackfill },
    'Starting wallet sync',
  );

  const runRes = await query<{ id: string }>(
    `INSERT INTO sync_runs (wallet_id, provider, chain, started_at, status)
     VALUES ($1, 'pending', 'base', NOW(), 'running')
     RETURNING id`,
    [wallet_id],
  );
  const syncRunId = runRes.rows[0].id;

  let ingested = 0;
  let failed = 0;
  let provider = 'unknown';

  try {
    const { pairs, provider: usedProvider } = await fetchTransfers(
      wallet_address,
      fromBlock,
      fromBlockNumber,
      toBlock,
      apiKey,
    );
    provider = usedProvider;

    for (const pair of pairs) {
      // Inject wallet_id and user_id (normalizers used placeholders)
      const tx: TxRow = { ...pair.tx, wallet_id, };
      const event: EventRow = { ...pair.event, wallet_id, user_id };

      // Skip tokens Luca doesn't track (airdrops, spam tokens, unknown ERC-20s)
      const rawContract =
        (pair.tx.raw_payload as { rawContract?: { address?: string | null } })?.rawContract;
      const pairContractAddress = rawContract?.address ?? null;
      if (!isTrackedAsset(pair.event.asset, pairContractAddress)) continue;

      try {
        // Enrich USD value for USDC (1:1), ETH, and BNKR (spot price at block time)
        const contractAddress =
          (pair.tx.raw_payload as { rawContract?: { address?: string | null } })
            ?.rawContract?.address ?? null;
        const priceResult = await enrichUsdValue(
          event.asset,
          contractAddress,
          event.amount,
          event.block_time,
        );
        const enrichedEvent: EventRow = { ...event, ...priceResult };
        const enrichedTx: TxRow = { ...tx, usd_value: priceResult.usd_value };

        const txSql = `
          INSERT INTO transactions
            (wallet_id, chain, hash, block_number, block_time, from_address, to_address,
             asset, amount, usd_value, gas_used, gas_price, gas_usd, direction, tx_type, raw_payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (chain, hash, wallet_id) DO UPDATE SET chain = EXCLUDED.chain
          RETURNING id`;

        const txParams = [
          enrichedTx.wallet_id, enrichedTx.chain, enrichedTx.hash, enrichedTx.block_number,
          enrichedTx.block_time, enrichedTx.from_address, enrichedTx.to_address,
          enrichedTx.asset, enrichedTx.amount, enrichedTx.usd_value,
          enrichedTx.gas_used, enrichedTx.gas_price, enrichedTx.gas_usd,
          enrichedTx.direction, enrichedTx.tx_type, JSON.stringify(enrichedTx.raw_payload),
        ];

        const txId = await insertOrGetTxId(wallet_id, enrichedTx.hash, enrichedTx.chain, txSql, txParams);

        await query(
          `INSERT INTO normalized_events
             (transaction_id, wallet_id, user_id, chain, hash, log_index, block_time,
              from_address, to_address, asset, amount, usd_value, price_source, price_at, direction)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (chain, hash, wallet_id, COALESCE(log_index, -1)) DO NOTHING`,
          [
            txId, enrichedEvent.wallet_id, enrichedEvent.user_id, enrichedEvent.chain,
            enrichedEvent.hash, enrichedEvent.log_index, enrichedEvent.block_time,
            enrichedEvent.from_address, enrichedEvent.to_address, enrichedEvent.asset,
            enrichedEvent.amount, enrichedEvent.usd_value, enrichedEvent.price_source,
            enrichedEvent.price_at, enrichedEvent.direction,
          ],
        );

        ingested++;
      } catch (err) {
        failed++;
        logger.error({ err, hash: tx.hash, wallet_id }, 'Failed to store transfer');
      }
    }

    // Snapshot balances
    await snapshotBalances(apiKey, wallet_id, user_id, wallet_address);

    // Advance cursor (only when Alchemy gave us a real block number)
    const newLastBlock = apiKey ? currentBlock : null;
    await query(
      `UPDATE watch_jobs
       SET last_synced_at = NOW(), last_block = $1, status = 'active', updated_at = NOW()
       WHERE id = $2`,
      [newLastBlock, job.id],
    );

    await query(
      `UPDATE sync_runs
       SET status = 'completed', completed_at = NOW(), events_ingested = $1, provider = $2
       WHERE id = $3`,
      [ingested, provider, syncRunId],
    );

    logger.info({ wallet_id, ingested, failed, provider, currentBlock }, 'Wallet sync complete');
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
}
