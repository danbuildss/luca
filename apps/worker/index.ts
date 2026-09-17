import 'dotenv/config';
import pino from 'pino';

import { readConfig } from '../../core/config.js';
import { checkDatabase, createDatabasePool } from '../../core/db/pool.js';

const config = readConfig(process.env);
const logger = pino({ level: config.logLevel });
const database = createDatabasePool(config.databaseUrl);

async function run(): Promise<void> {
  await checkDatabase(database);
  logger.info('Luca worker foundation is ready; no financial jobs are enabled in Phase 1');

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

try {
  await run();
  await database.end();
  logger.info('Luca worker stopped');
} catch (error) {
  logger.fatal({ error }, 'Luca worker failed');
  await database.end();
  process.exitCode = 1;
}
