// Luca Telegram bot — Gate E implementation placeholder
// Responsibilities: receive commands, route to Hermes/Luca Core, deliver responses
import { config, requireProductionConfig } from '../../src/config.js';
import { closeDb } from '../../src/db.js';
import { logger } from '../../src/logger.js';

if (config.NODE_ENV === 'production') {
  requireProductionConfig();
}

logger.info('Luca Telegram bot starting (Gate E not yet implemented)');

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — bot shutting down');
  await closeDb();
  process.exit(0);
});
