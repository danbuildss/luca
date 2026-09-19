import Fastify from 'fastify';
import { config, requireProductionConfig } from '../../src/config.js';
import { checkDbReady, closeDb } from '../../src/db.js';
import { logger } from '../../src/logger.js';

if (config.NODE_ENV === 'production') {
  requireProductionConfig();
}

// Pass pino options to Fastify rather than a logger instance (type compatibility)
const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'key_hash', 'token'],
  },
});

// Health: reports process and DB readiness separately
app.get('/health', async (_req, reply) => {
  const dbReady = await checkDbReady();
  const status = dbReady ? 'ok' : 'degraded';

  return reply.status(dbReady ? 200 : 503).send({
    status,
    version: '0.1.0',
    process: 'ok',
    db: dbReady ? 'ok' : 'error',
    env: config.NODE_ENV,
  });
});

const start = async () => {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info({ port: config.PORT }, 'Luca API listening');
  } catch (err) {
    logger.error(err, 'Failed to start API');
    process.exit(1);
  }
};

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down');
  await app.close();
  await closeDb();
  process.exit(0);
});

void start();
