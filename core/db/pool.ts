import pg from 'pg';

const { Pool } = pg;

export type DatabasePool = pg.Pool;

export function createDatabasePool(connectionString: string): DatabasePool {
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  });
}

export async function checkDatabase(pool: DatabasePool): Promise<void> {
  await pool.query('SELECT 1');
}
