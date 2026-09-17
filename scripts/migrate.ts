import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';

import { readConfig } from '../core/config.js';

const { Client } = pg;
const migrationsDirectory = join(process.cwd(), 'db', 'migrations');
const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;

type AppliedMigration = {
  name: string;
  checksum: string;
};

function selectDatabaseUrl(): string {
  const config = readConfig(process.env);
  const useTestDatabase = process.argv.includes('--test');

  if (!useTestDatabase) {
    return config.databaseUrl;
  }

  if (config.testDatabaseUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required with --test');
  }

  const databaseName = new URL(config.testDatabaseUrl).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error('Refusing to migrate a test database whose name does not end with _test');
  }

  return config.testDatabaseUrl;
}

async function migrate(): Promise<void> {
  const client = new Client({ connectionString: selectDatabaseUrl() });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [1_735_822_231]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((name) => migrationFilePattern.test(name))
      .sort();
    const appliedResult = await client.query<AppliedMigration>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.checksum]));

    for (const name of migrationFiles) {
      const sql = await readFile(join(migrationsDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existingChecksum = applied.get(name);

      if (existingChecksum !== undefined) {
        if (existingChecksum !== checksum) {
          throw new Error(`Applied migration ${name} has been modified`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
        process.stdout.write(`Applied ${name}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [1_735_822_231]).catch(() => undefined);
    await client.end();
  }
}

await migrate();
