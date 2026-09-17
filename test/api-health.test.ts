import { afterEach, describe, expect, it } from 'vitest';

import { buildApi } from '../apps/api/app.js';

const apps: ReturnType<typeof buildApi>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('health endpoints', () => {
  it('reports process liveness without querying PostgreSQL', async () => {
    let databaseChecked = false;
    const app = buildApi({
      checkDatabase: async () => {
        databaseChecked = true;
      },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'luca-api',
      checks: { process: 'up' },
    });
    expect(databaseChecked).toBe(false);
  });

  it('reports readiness when PostgreSQL responds', async () => {
    const app = buildApi({ checkDatabase: async () => undefined });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: { process: 'up', database: 'up' },
    });
  });

  it('returns 503 without leaking database errors', async () => {
    const app = buildApi({
      checkDatabase: async () => {
        throw new Error('postgresql://operator:secret@database.example/luca');
      },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      service: 'luca-api',
      checks: { process: 'up', database: 'down' },
    });
    expect(response.body).not.toContain('secret');
  });
});
