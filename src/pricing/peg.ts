import { query } from '../db.js';
import { logger } from '../logger.js';
import { usdcUsdAt } from './onchain.js';

// USDC is counted at $1. When Chainlink's USDC/USD moves more than this far from $1,
// every operator holding USDC is told once a day while it lasts.
export const DEPEG_THRESHOLD = 0.02;

export async function checkUsdcPeg(apiKey: string): Promise<number | null> {
  const price = await usdcUsdAt(apiKey, 'latest');
  if (price === null || Math.abs(price - 1) <= DEPEG_THRESHOLD) return price;

  const day = new Date().toISOString().slice(0, 10);
  const holders = await query<{ user_id: string }>(
    `SELECT DISTINCT bs.user_id
     FROM balance_snapshots bs
     JOIN wallets w ON w.id = bs.wallet_id AND w.active = TRUE
     WHERE bs.asset = 'USDC' AND bs.balance > 0
       AND bs.snapshot_at = (SELECT MAX(s2.snapshot_at) FROM balance_snapshots s2
                             WHERE s2.wallet_id = bs.wallet_id AND s2.asset = 'USDC')`,
  );
  const shown = `$${price.toFixed(4)}`;
  for (const { user_id } of holders.rows) {
    await query(
      `INSERT INTO alerts (user_id, type, message, evidence, dedup_key)
       VALUES ($1, 'usdc_depeg', $2, $3, $4)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [
        user_id,
        [
          'USDC is off its $1 peg',
          `Chainlink shows USDC at ${shown}, more than ${DEPEG_THRESHOLD * 100}% away from $1. I still count USDC at $1 in your books, so while this lasts your USDC is worth ${price < 1 ? 'less' : 'more'} than the figures show.`,
        ].join('\n'),
        JSON.stringify({ usdc_usd: price, source: 'chainlink' }),
        `usdc_depeg:${user_id}:${day}`,
      ],
    );
  }
  logger.warn({ price, users: holders.rows.length }, 'USDC off peg');
  return price;
}
