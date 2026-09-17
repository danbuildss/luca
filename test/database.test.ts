import pg from 'pg';
import { describe, expect, it } from 'vitest';

const { Client } = pg;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = testDatabaseUrl ?? '';

describe.skipIf(testDatabaseUrl === undefined)('database migration', () => {
  it('creates the migration record and core tables', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      const migrations = await client.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      );
      const tables = await client.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `);

      expect(migrations.rows.map((row) => row.name)).toEqual(['0001_initial_schema.sql']);
      expect(tables.rows.map((row) => row.table_name)).toEqual(
        expect.arrayContaining(['users', 'wallets', 'financial_events', 'classifications']),
      );
    } finally {
      await client.end();
    }
  });
});
