import { query } from '../db.js';
import { logger } from '../logger.js';
import {
  detectLargeMovements,
  detectSpendSpike,
  detectTreasuryFloor,
  detectUnusualGas,
  detectClassifierDegradation,
} from './detectors.js';
import { detectPortfolioChanges } from '../heartbeat/detector.js';
// Same staleness threshold /ops uses
import { STALE_HOURS } from '../ops/metrics.js';

// True when any active wallet has not synced recently or its last sync failed. Detectors
// that draw conclusions from recent totals (spikes) then stay silent; the wallet_stale
// notice tells the operator about the data instead.
export async function hasStaleData(userId: string): Promise<boolean> {
  const res = await query<{ stale: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM wallets w JOIN watch_jobs wj ON wj.wallet_id = w.id
       WHERE w.user_id = $1 AND w.active = TRUE
         AND (wj.status = 'error' OR wj.last_synced_at IS NULL
              OR wj.last_synced_at < NOW() - ($2::int * INTERVAL '1 hour'))
     ) AS stale`,
    [userId, STALE_HOURS],
  );
  return res.rows[0]?.stale ?? false;
}

export async function runAlertDetectors(userId: string): Promise<number> {
  const stale = await hasStaleData(userId);
  const detectors: Array<[string, (userId: string) => Promise<number>]> = [
    // A transfer seen on chain is a verified fact whatever else is late
    ['large_movements', detectLargeMovements],
    ['classifier_degradation', detectClassifierDegradation],
    // Guarded internally: fresh balances only, and complete comparable snapshots only
    ['treasury_floor', detectTreasuryFloor],
    ['portfolio_changes', detectPortfolioChanges],
    // Totals over the last 24 hours are wrong while a wallet is behind
    ...(stale ? [] : [
      ['spend_spike', detectSpendSpike],
      ['unusual_gas', detectUnusualGas],
    ] as Array<[string, (userId: string) => Promise<number>]>),
  ];
  if (stale) logger.info({ userId }, 'Spike detectors skipped: wallet data is stale');

  const results = await Promise.allSettled(detectors.map(([, run]) => run(userId)));

  let total = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') total += r.value;
    else logger.error({ err: r.reason as unknown, detector: detectors[i][0], userId }, 'Alert detector failed');
  });

  if (total > 0) {
    logger.info({ userId, newAlerts: total }, 'Alert detectors fired');
  }
  return total;
}
