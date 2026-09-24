import { config, requireProductionConfig } from '../../src/config.js';
import { closeDb } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { getActiveWatchJobs, syncWallet } from '../../src/ingestion/ingest.js';
import { repriceMissing, upgradePrices, priceSwaps } from '../../src/ingestion/reprice.js';
import { checkUsdcPeg } from '../../src/pricing/peg.js';
import { reconcileDueWallets } from '../../src/ledger/reconcile.js';
import { classifyAllUsers } from '../../src/classification/engine.js';
import { getDistinctUserIds } from '../../src/classification/store.js';
import { refreshQuestionGroups } from '../../src/alerts/questions.js';
import { runAlertDetectors } from '../../src/alerts/engine.js';
import { deliverPendingAlerts } from '../../src/alerts/deliver.js';
import { startBriefScheduler } from '../../src/briefs/scheduler.js';
import { pingWorkerHeartbeat } from '../../src/health/monitor.js';
import { detectStaleWallets, detectDiskPressure } from '../../src/health/detectors.js';
import { takeHeartbeatSnapshot } from '../../src/heartbeat/snapshot.js';

if (config.NODE_ENV === 'production') {
  requireProductionConfig();
}

if (!config.ALCHEMY_API_KEY) {
  logger.warn('ALCHEMY_API_KEY not set — falling back to Blockscout for all wallets');
}

const apiKey = config.ALCHEMY_API_KEY;
const POLL_INTERVAL_MS = 60_000;

let shuttingDown = false;
let currentCycle: Promise<void> | null = null;

async function runCycle(): Promise<void> {
  await pingWorkerHeartbeat().catch(() => { /* non-fatal */ });

  const jobs = await getActiveWatchJobs();
  logger.info({ count: jobs.length }, 'Sync cycle started');

  for (const job of jobs) {
    if (shuttingDown) break;
    try {
      await syncWallet(job, apiKey);
    } catch (err) {
      logger.error({ err, wallet_id: job.wallet_id }, 'Sync failed — wallet marked error');
    }
  }

  if (!shuttingDown && apiKey) {
    await reconcileDueWallets(apiKey).catch((err: unknown) => logger.error({ err }, 'Balance check failed'));
  }

  if (!shuttingDown) {
    await repriceMissing(50, apiKey).catch((err: unknown) => logger.error({ err }, 'Re-pricing failed'));
    await classifyAllUsers();
    // After classification: swaps are known, so BNKR in a swap takes the traded price
    await priceSwaps().catch((err: unknown) => logger.error({ err }, 'Swap pricing failed'));
    if (apiKey) {
      await upgradePrices(apiKey).catch((err: unknown) => logger.error({ err }, 'On-chain re-pricing failed'));
      await checkUsdcPeg(apiKey).catch((err: unknown) => logger.error({ err }, 'USDC peg check failed'));
    }
  }

  if (!shuttingDown) {
    const userIds = await getDistinctUserIds();
    const steps: Array<[string, (userId: string) => Promise<unknown>]> = [
      ['questions', refreshQuestionGroups],
      ['heartbeat snapshot', takeHeartbeatSnapshot],
      ['alert detectors', runAlertDetectors],
      ['stale wallets', detectStaleWallets],
      ['disk pressure', detectDiskPressure],
      ['alert delivery', deliverPendingAlerts],
    ];
    // Each step is isolated: one failing detector must not stop alert delivery
    // for this user or skip the users after them.
    for (const userId of userIds) {
      for (const [name, step] of steps) {
        try {
          await step(userId);
        } catch (err: unknown) {
          logger.error({ err, userId, step: name }, 'Per-user worker step failed');
        }
      }
    }
  }
}

async function poll(): Promise<void> {
  if (shuttingDown) return;

  currentCycle = runCycle().catch((err: unknown) => {
    logger.error({ err }, 'Unexpected error in sync cycle');
  });
  await currentCycle;

  if (!shuttingDown) {
    setTimeout(() => void poll(), POLL_INTERVAL_MS);
  }
}

process.on('SIGTERM', () => {
  void (async () => {
    logger.info('SIGTERM received — worker shutting down');
    shuttingDown = true;
    if (currentCycle) await currentCycle;
    await closeDb();
    process.exit(0);
  })();
});

logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'Luca worker starting');
startBriefScheduler();
void poll();
