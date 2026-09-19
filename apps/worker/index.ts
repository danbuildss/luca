// Luca ingestion worker — Gate B implementation placeholder
// Responsibilities: wallet sync, normalization, classification, alert evaluation
import { config, requireProductionConfig } from '../../src/config.js';
import { closeDb } from '../../src/db.js';
import { logger } from '../../src/logger.js';

if (config.NODE_ENV === 'production') {
  requireProductionConfig();
}

logger.info('Luca worker starting (Gate B not yet implemented)');

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — worker shutting down');
  await closeDb();
  process.exit(0);
});
