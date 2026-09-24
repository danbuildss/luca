import { query } from '../db.js';
import { logger } from '../logger.js';
import { enrichUsdValue, ONCHAIN_PRICE_SOURCES, type ChainContext } from './price.js';
import { BASE_BNKR } from './assets.js';

type PriceRow = {
  id: string;
  asset: string | null;
  token_address: string | null;
  amount: string;
  block_time: Date;
  block_number: string | null;
};

async function price(row: PriceRow, apiKey: string | undefined) {
  const chain: ChainContext | undefined = apiKey && row.block_number
    ? { apiKey, blockNumber: Number(row.block_number) }
    : undefined;
  return enrichUsdValue(
    { supported: true, symbol: row.asset, tokenAddress: row.token_address },
    parseFloat(row.amount),
    row.block_time,
    new Date(),
    chain,
  );
}

// Fills USD values for supported transfers whose price lookup failed (price_source NULL).
export async function repriceMissing(limit = 50, apiKey: string | undefined = undefined): Promise<number> {
  const res = await query<PriceRow>(
    `SELECT id, asset, token_address, amount::text, block_time, block_number::text
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
    const p = await price(row, apiKey);
    if (p.price_source === null) continue;
    await query(
      `UPDATE normalized_events
       SET usd_value = $2, price_source = $3, price_at = $4, price_ref = $5, price_checked_at = NOW()
       WHERE id = $1 AND usd_value IS NULL`,
      [row.id, p.usd_value, p.price_source, p.price_at, p.price_ref ?? null],
    );
    priced++;
  }

  if (priced > 0) logger.info({ priced, checked: res.rows.length }, 'Re-priced transfers');
  return priced;
}

// Replaces older prices (CoinGecko daily, BNKR without a price) with ones read on chain at
// the transfer's block. Each transfer is tried at most once a day, so a source that is
// down does not cost a read per transfer every minute. Labels are never touched.
export async function upgradePrices(apiKey: string, limit = 100): Promise<number> {
  const res = await query<PriceRow>(
    `SELECT id, asset, token_address, amount::text, block_time, block_number::text
     FROM normalized_events
     WHERE supported IS TRUE
       AND block_number IS NOT NULL
       AND amount IS NOT NULL AND amount <> 0
       AND (token_address IS NULL OR token_address = $2)
       AND (price_source IS NULL OR price_source <> ALL($3::text[]))
       AND (price_checked_at IS NULL OR price_checked_at < NOW() - INTERVAL '1 day')
     ORDER BY block_time DESC
     LIMIT $1`,
    [limit, BASE_BNKR, ONCHAIN_PRICE_SOURCES],
  );

  let upgraded = 0;
  for (const row of res.rows) {
    const p = await price(row, apiKey);
    if (p.price_source !== null && ONCHAIN_PRICE_SOURCES.includes(p.price_source)) {
      await query(
        `UPDATE normalized_events
         SET usd_value = $2, price_source = $3, price_at = $4, price_ref = $5, price_checked_at = NOW()
         WHERE id = $1`,
        [row.id, p.usd_value, p.price_source, p.price_at, p.price_ref ?? null],
      );
      upgraded++;
    } else {
      await query(`UPDATE normalized_events SET price_checked_at = NOW() WHERE id = $1`, [row.id]);
    }
  }
  if (upgraded > 0) logger.info({ upgraded, checked: res.rows.length }, 'Prices read on chain');
  return upgraded;
}

// BNKR bought or sold in a swap is worth what the operator actually traded it for: the
// USD value of the other side of the swap, spread over the BNKR amount.
export async function priceSwaps(limit = 100): Promise<number> {
  const res = await query<{ id: string; amount: string; hash: string; user_id: string; other_usd: string; bnkr_total: string }>(
    `WITH bnkr AS (
       SELECT ne.id, ne.amount, ne.hash, ne.user_id
       FROM normalized_events ne
       JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
       WHERE ne.supported IS TRUE AND ne.token_address = $2 AND c.shape = 'swap'
         AND ne.price_source IS DISTINCT FROM 'swap'
       LIMIT $1
     )
     SELECT b.id, b.amount::text, b.hash, b.user_id, o.other_usd::text,
            (SELECT SUM(CASE WHEN x.direction = 'in' THEN x.amount ELSE -x.amount END)
             FROM normalized_events x
             WHERE x.user_id = b.user_id AND LOWER(x.hash) = LOWER(b.hash)
               AND x.supported IS TRUE AND x.token_address = $2 AND x.source_key <> 'gas')::text AS bnkr_total
     FROM bnkr b
     JOIN LATERAL (
       -- The other side, net: what was paid for BNKR bought (or received for BNKR sold)
       SELECT ABS(SUM(CASE WHEN o.direction = 'in' THEN o.usd_value ELSE -o.usd_value END)) AS other_usd,
              BOOL_AND(o.usd_value IS NOT NULL) AS all_priced
       FROM normalized_events o
       WHERE o.user_id = b.user_id AND LOWER(o.hash) = LOWER(b.hash)
         AND o.supported IS TRUE AND o.source_key <> 'gas'
         AND o.token_address IS DISTINCT FROM $2
     ) o ON o.all_priced AND o.other_usd > 0`,
    [limit, BASE_BNKR],
  );

  let priced = 0;
  for (const r of res.rows) {
    const bnkr = Math.abs(parseFloat(r.bnkr_total));
    if (!(bnkr > 0)) continue;
    const unit = parseFloat(r.other_usd) / bnkr;
    await query(
      `UPDATE normalized_events
       SET usd_value = amount * $2::numeric, price_source = 'swap', price_at = block_time,
           price_ref = $3, price_checked_at = NOW()
       WHERE id = $1`,
      [r.id, unit, `Your swap in ${r.hash.slice(0, 10)}…: $${unit.toPrecision(4)} per BNKR`],
    );
    priced++;
  }
  if (priced > 0) logger.info({ priced }, 'Priced BNKR from swaps');
  return priced;
}
