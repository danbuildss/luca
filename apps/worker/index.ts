import { config, requireProductionConfig } from '../../src/config.js';
import { closeDb } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { getActiveWatchJobs, syncWallet } from '../../src/ingestion/ingest.js';
import { repriceMissing } from '../../src/ingestion/reprice.js';
import { classifyAllUsers } from '../../src/classification/engine.js';
import { getDistinctUserIds } from '../../src/classification/store.js';
import { detectUnknownCounterparties } from '../../src/alerts/counterparty.js';
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

  if (!shuttingDown) {
    await repriceMissing().catch((err: unknown) => logger.error({ err }, 'Re-pricing failed'));
    await classifyAllUsers();
  }

  if (!shuttingDown) {
    const userIds = await getDistinctUserIds();
    for (const userId of userIds) {
      await detectUnknownCounterparties(userId);
      await takeHeartbeatSnapshot(userId);
      await runAlertDetectors(userId);
      await detectStaleWallets(userId);
      await detectDiskPressure(userId);
      await deliverPendingAlerts(userId);
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
