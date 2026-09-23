import { logger } from '../logger.js';
import {
  detectLargeMovements,
  detectSpendSpike,
  detectTreasuryFloor,
  detectUnusualGas,
} from './detectors.js';

export async function runAlertDetectors(userId: string): Promise<number> {
  const results = await Promise.allSettled([
    detectLargeMovements(userId),
    detectSpendSpike(userId),
    detectTreasuryFloor(userId),
    detectUnusualGas(userId),
  ]);

  let total = 0;
  const names = ['large_movements', 'spend_spike', 'treasury_floor', 'unusual_gas'];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      total += r.value;
    } else {
      logger.error({ err: r.reason as unknown, detector: names[i], userId }, 'Alert detector failed');
    }
  }

  if (total > 0) {
    logger.info({ userId, newAlerts: total }, 'Alert detectors fired');
  }
  return total;
}
