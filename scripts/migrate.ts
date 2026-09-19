import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();

  try {
    // Migration tracking table — must use plain SQL, not our migration system
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort(); // lexicographic order — 001_, 002_, etc.

    for (const file of files) {
      const version = file.replace('.sql', '');
      const { rows } = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version],
      );

      if (rows.length > 0) {
        console.log(`  skip  ${version} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version],
        );
        await client.query('COMMIT');
        console.log(`  apply ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  FAIL  ${version}:`, err);
        process.exit(1);
      }
    }

    console.log('Migrations complete.');
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
