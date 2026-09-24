import { query } from '../db.js';
import { logger } from '../logger.js';
import { enrichUsdValue } from './price.js';

// Fills USD values for supported transfers whose price lookup failed (price_source NULL).
// ETH gets its daily price; recent BNKR gets spot; older BNKR becomes 'unavailable'.
export async function repriceMissing(limit = 50): Promise<number> {
  const res = await query<{
    id: string;
    asset: string | null;
    token_address: string | null;
    amount: string;
    block_time: Date;
  }>(
    `SELECT id, asset, token_address, amount::text, block_time
     FROM normalized_events
     WHERE supported IS TRUE
       AND usd_value IS NULL
       AND price_source IS NULL
       AND amount IS NOT NULL AND amount <> 0
     ORDER BY block_time DESC
     LIMIT $1`,
    [limit],
  );

  let priced = 0;
  for (const row of res.rows) {
    const price = await enrichUsdValue(
      { supported: true, symbol: row.asset, tokenAddress: row.token_address },
      parseFloat(row.amount),
      row.block_time,
    );
    if (price.price_source === null) continue;
    await query(
      `UPDATE normalized_events
       SET usd_value = $2, price_source = $3, price_at = $4
       WHERE id = $1 AND usd_value IS NULL`,
      [row.id, price.usd_value, price.price_source, price.price_at],
    );
    priced++;
  }

  if (priced > 0) logger.info({ priced, checked: res.rows.length }, 'Re-priced transfers');
  return priced;
}
