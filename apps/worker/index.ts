import { config, requireProductionConfig } from '../../src/config.js';
import { closeDb } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { getActiveWatchJobs, syncWallet } from '../../src/ingestion/ingest.js';

if (config.NODE_ENV === 'production') {
  requireProductionConfig();
}

if (!config.ALCHEMY_API_KEY) {
  logger.error('ALCHEMY_API_KEY is required for the worker — exiting');
  process.exit(1);
}

const apiKey = config.ALCHEMY_API_KEY;
const POLL_INTERVAL_MS = 60_000;

let shuttingDown = false;
let currentCycle: Promise<void> | null = null;

async function runCycle(): Promise<void> {
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
}

async function poll(): Promise<void> {
  if (shuttingDown) return;

  currentCycle = runCycle().catch((err) => {
    logger.error({ err }, 'Unexpected error in sync cycle');
  });
  await currentCycle;

  if (!shuttingDown) {
    setTimeout(() => void poll(), POLL_INTERVAL_MS);
  }
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — worker shutting down');
  shuttingDown = true;
  if (currentCycle) await currentCycle;
  await closeDb();
  process.exit(0);
});

logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'Luca worker starting');
void poll();
