import 'dotenv/config';
import pino from 'pino';

import { readConfig } from '../../core/config.js';
import { checkDatabase, createDatabasePool } from '../../core/db/pool.js';
import { buildApi } from './app.js';

const config = readConfig(process.env);
const logger = pino({ level: config.logLevel });
const database = createDatabasePool(config.databaseUrl);
const app = buildApi({
  checkDatabase: async () => checkDatabase(database),
  logger: true,
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'stopping Luca API');
  await app.close();
  await database.end();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      logger.error({ error }, 'failed to stop Luca API cleanly');
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logger.fatal({ error }, 'failed to start Luca API');
  await database.end();
  process.exitCode = 1;
}
