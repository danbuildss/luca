import Fastify, { type FastifyInstance } from 'fastify';

type BuildApiOptions = {
  checkDatabase: () => Promise<void>;
  logger?: boolean;
};

export function buildApi(options: BuildApiOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'luca-api',
    checks: {
      process: 'up',
    },
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      await options.checkDatabase();
      return {
        status: 'ready',
        service: 'luca-api',
        checks: {
          process: 'up',
          database: 'up',
        },
      };
    } catch {
      return reply.code(503).send({
        status: 'not_ready',
        service: 'luca-api',
        checks: {
          process: 'up',
          database: 'down',
        },
      });
    }
  });

  return app;
}
