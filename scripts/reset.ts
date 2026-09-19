// DANGER: drops and recreates the database. Only for development and test.
import pg from 'pg';
import { config } from '../src/config.js';

if (config.NODE_ENV === 'production') {
  console.error('reset.ts must never run in production');
  process.exit(1);
}

async function reset() {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    console.log('Database reset. Run npm run db:migrate to recreate schema.');
  } finally {
    await client.end();
  }
}

reset().catch((err) => {
  console.error('Reset error:', err);
  process.exit(1);
});
