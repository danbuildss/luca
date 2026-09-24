// Integration-test harness: runs the REAL SQL in src/ against a real Postgres.
//
// How to run
// ----------
//   1. Have a Postgres reachable at the DATABASE_URL set in vitest.config.ts
//      (postgresql://postgres:luca@localhost:5432/luca_test), e.g.
//        docker run -d --name luca-pg -e POSTGRES_PASSWORD=luca -p 5432:5432 postgres:16
//        docker exec luca-pg createdb -U postgres luca_test
//   2. LUCA_INTEGRATION=1 npx vitest run tests/integration
//      (PowerShell: $env:LUCA_INTEGRATION='1'; npx vitest run tests/integration)
//
// Without LUCA_INTEGRATION=1, or when the DB is unreachable, every suite using
// `describeDb` is skipped, so a plain `vitest run` stays green without Postgres.
//
// What it does
// ------------
// - Refuses to touch a database whose name does not contain "test".
// - Each test file takes a session-level advisory lock for its whole run, so test
//   files (which vitest runs in parallel workers) never share the DB concurrently.
// - Once per file: DROP SCHEMA public CASCADE, recreate it, and apply every
//   migrations/*.sql in lexicographic order, each in its own transaction and
//   recorded in schema_migrations (mirrors scripts/migrate.ts).
// - Before each test: TRUNCATE every table except schema_migrations and the
//   worker_heartbeat singleton (re-pinged instead, since ops_daily_summary
//   CROSS JOINs it).
// - After the file: closes src/db.ts's pool (closeDb) and the harness client.
//
// Fixtures are inserted through the harness's own client (autocommit), so they
// are visible to the code under test, which uses src/db.ts's pool.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { closeDb } from '../../../src/db.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const LOCK_KEY = 4_815_162_342; // arbitrary, bigint advisory-lock key

export const INTEGRATION_ENABLED = process.env.LUCA_INTEGRATION === '1';

async function probe(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3_000 });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('SELECT 1');
    return true;
  } catch (err) {
    console.warn(`[integration] LUCA_INTEGRATION=1 but DB unreachable — skipping: ${(err as Error).message}`);
    return false;
  } finally {
    if (connected) await client.end().catch(() => undefined);
  }
}

export const dbAvailable: boolean = INTEGRATION_ENABLED ? await probe() : false;

/** `describe` that is skipped unless LUCA_INTEGRATION=1 and the test DB is reachable. */
export const describeDb = describe.skipIf(!dbAvailable);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let client: pg.Client | null = null;

function db(): pg.Client {
  if (!client) throw new Error('useIntegrationDb() must be called inside the describeDb block');
  return client;
}

/** Raw SQL through the harness client (fixtures / assertions). */
export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await db().query<T>(text, params);
  return res.rows;
}

async function resetSchema(c: pg.Client): Promise<void> {
  const { rows } = await c.query<{ db: string }>('SELECT current_database() AS db');
  if (!/test/i.test(rows[0].db)) {
    throw new Error(`Refusing to reset schema of non-test database "${rows[0].db}"`);
  }

  await c.query('DROP SCHEMA IF EXISTS public CASCADE');
  await c.query('CREATE SCHEMA public');
  await c.query('GRANT ALL ON SCHEMA public TO public');

  // Mirror scripts/migrate.ts
  await c.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const version = file.replace('.sql', '');
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    await c.query('BEGIN');
    try {
      await c.query(text);
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw new Error(`Migration ${version} failed: ${(err as Error).message}`);
    }
  }
}

async function truncateAll(c: pg.Client): Promise<void> {
  const { rows } = await c.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT IN ('schema_migrations', 'worker_heartbeat')`,
  );
  if (rows.length > 0) {
    const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    await c.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  }
  await c.query(
    `INSERT INTO worker_heartbeat (id, last_ping_at, loop_count) VALUES (1, NOW(), 0)
     ON CONFLICT (id) DO UPDATE SET last_ping_at = NOW(), loop_count = 0`,
  );
}

/**
 * Registers beforeAll / beforeEach / afterAll hooks. Call once at the top of the file's
 * single top-level describeDb block (nest further `describe`s inside it) — afterAll closes
 * src/db.ts's pool, which cannot be reopened within the same file.
 */
export function useIntegrationDb(): void {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    // Serialise test files across vitest workers (released in afterAll / on disconnect)
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await resetSchema(client);
  }, 180_000);

  beforeEach(async () => {
    await truncateAll(db());
  });

  afterAll(async () => {
    await closeDb().catch(() => undefined);
    if (client) {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
      await client.end().catch(() => undefined);
      client = null;
    }
  });
}

// ---------------------------------------------------------------------------
// Time helpers — everything is relative to the DB clock (NOW()), because that's
// what the SQL under test compares against.
// ---------------------------------------------------------------------------

/** A timestamp: a Date, or a Postgres interval string meaning "that long before NOW()". */
export type At = Date | string;

function atExpr(at: At, paramIdx: number): string {
  return typeof at === 'string' ? `(NOW() - $${paramIdx}::interval)` : `$${paramIdx}::timestamptz`;
}

/** Evaluate a SQL timestamp expression on the DB, e.g. `DATE_TRUNC('week', NOW()) - INTERVAL '3 days'`. */
export async function dbTime(expr: string, params: unknown[] = []): Promise<Date> {
  const rows = await sql<{ t: Date }>(`SELECT (${expr})::timestamptz AS t`, params);
  return rows[0].t;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
const next = (): number => ++seq;

/** Deterministic, unique, lowercase 0x address. */
export function addr(tag?: number): string {
  const n = tag ?? next();
  return `0x${n.toString(16).padStart(40, '0')}`;
}

export type Label =
  | 'revenue' | 'expense' | 'internal_transfer' | 'treasury' | 'gas'
  | 'x402_income' | 'x402_spend' | 'refund' | 'unknown';

export type UserFx = { id: string; telegramId: number };
export type WalletFx = { id: string; userId: string; address: string };
export type EventFx = {
  id: string;
  transactionId: string;
  userId: string;
  walletId: string;
  hash: string;
  direction: 'in' | 'out';
  from: string;
  to: string | null;
};

export async function insertUser(opts: {
  telegramId?: number;
  username?: string | null;
  materialityUsd?: number;
  timezone?: string;
  briefTime?: string;
  role?: 'operator' | 'admin';
  createdAt?: At;
} = {}): Promise<UserFx> {
  const telegramId = opts.telegramId ?? 100_000 + next();
  const params: unknown[] = [
    telegramId,
    opts.username ?? null,
    opts.materialityUsd ?? 50,
    opts.timezone ?? 'UTC',
    opts.briefTime ?? '08:00',
    opts.role ?? 'operator',
  ];
  let createdAt = 'NOW()';
  if (opts.createdAt !== undefined) {
    params.push(opts.createdAt);
    createdAt = atExpr(opts.createdAt, params.length);
  }
  const rows = await sql<{ id: string }>(
    `INSERT INTO users (telegram_id, telegram_username, materiality_usd, timezone, brief_time, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::user_role, ${createdAt})
     RETURNING id`,
    params,
  );
  return { id: rows[0].id, telegramId };
}

export async function insertWallet(opts: {
  userId: string;
  address?: string;
  chain?: 'base' | 'solana';
  label?: string | null;
  active?: boolean;
}): Promise<WalletFx> {
  const address = (opts.address ?? addr()).toLowerCase();
  const rows = await sql<{ id: string }>(
    `INSERT INTO wallets (user_id, address, chain, label, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [opts.userId, address, opts.chain ?? 'base', opts.label ?? null, opts.active ?? true],
  );
  return { id: rows[0].id, userId: opts.userId, address };
}

export async function insertWatchJob(opts: {
  userId: string;
  walletId: string;
  status?: 'active' | 'paused' | 'error';
  lastSyncedAt?: At | null;
  errorMessage?: string | null;
}): Promise<string> {
  const params: unknown[] = [opts.userId, opts.walletId, opts.status ?? 'active', opts.errorMessage ?? null];
  let synced = 'NULL';
  if (opts.lastSyncedAt != null) {
    params.push(opts.lastSyncedAt);
    synced = atExpr(opts.lastSyncedAt, params.length);
  }
  const rows = await sql<{ id: string }>(
    `INSERT INTO watch_jobs (user_id, wallet_id, status, error_message, last_synced_at)
     VALUES ($1, $2, $3, $4, ${synced}) RETURNING id`,
    params,
  );
  return rows[0].id;
}

/**
 * Inserts a transactions row + its normalized_events row.
 * direction 'in': counterparty → wallet; 'out': wallet → counterparty.
 */
export async function insertEvent(opts: {
  wallet: WalletFx;
  direction: 'in' | 'out';
  counterparty?: string | null;
  asset?: string | null;
  amount?: number | string | null;
  usdValue?: number | string | null;
  at?: At; // block_time; default '1 hour' ago
  hash?: string;
  sourceKey?: string;
  logIndex?: number | null;
}): Promise<EventFx> {
  const n = next();
  const hash = opts.hash ?? `0x${n.toString(16).padStart(64, '0')}`;
  const cp = opts.counterparty === undefined ? addr() : opts.counterparty;
  const from = opts.direction === 'in' ? (cp ?? addr()) : opts.wallet.address;
  const to = opts.direction === 'in' ? opts.wallet.address : cp;
  const asset = opts.asset === undefined ? 'USDC' : opts.asset;
  const amount = opts.amount === undefined ? 10 : opts.amount;
  const usd = opts.usdValue === undefined ? null : opts.usdValue;
  const at = opts.at ?? '1 hour';

  const txRows = await sql<{ id: string }>(
    `INSERT INTO transactions
       (wallet_id, chain, hash, block_time, from_address, to_address, asset, amount, usd_value, direction, tx_type)
     VALUES ($1, 'base', $2, ${atExpr(at, 3)}, $4, $5, $6, $7, $8, $9, 'transfer')
     RETURNING id`,
    [opts.wallet.id, hash, at, from, to, asset, amount, usd, opts.direction],
  );
  const transactionId = txRows[0].id;

  const evRows = await sql<{ id: string }>(
    `INSERT INTO normalized_events
       (transaction_id, wallet_id, user_id, chain, hash, log_index, block_time,
        from_address, to_address, asset, amount, usd_value, direction, source_key)
     VALUES ($1, $2, $3, 'base', $4, $5, ${atExpr(at, 6)}, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      transactionId, opts.wallet.id, opts.wallet.userId, hash, opts.logIndex ?? null, at,
      from, to, asset, amount, usd, opts.direction, opts.sourceKey ?? 'external',
    ],
  );
  return {
    id: evRows[0].id,
    transactionId,
    userId: opts.wallet.userId,
    walletId: opts.wallet.id,
    hash,
    direction: opts.direction,
    from,
    to,
  };
}

export async function insertClassification(opts: {
  eventId: string;
  userId: string;
  label: Label;
  confidence?: number;
  method?: 'deterministic' | 'counterparty' | 'pattern' | 'model';
  evidence?: string | null;
  source?: 'user' | 'failure' | null;
  attempts?: number;
  /** retry_after = NOW() + this many seconds (negative = in the past); null/omitted = NULL */
  retryAfterSeconds?: number | null;
  superseded?: boolean;
  createdAt?: At;
}): Promise<string> {
  const params: unknown[] = [
    opts.eventId,
    opts.userId,
    opts.label,
    opts.confidence ?? 0.9,
    opts.method ?? 'model',
    opts.evidence ?? 'fixture',
    opts.source ?? null,
    opts.attempts ?? 0,
    opts.retryAfterSeconds ?? null,
  ];
  let createdAt = 'NOW()';
  if (opts.createdAt !== undefined) {
    params.push(opts.createdAt);
    createdAt = atExpr(opts.createdAt, params.length);
  }
  const rows = await sql<{ id: string }>(
    `INSERT INTO classifications
       (event_id, user_id, label, confidence, method, evidence, source, attempts, retry_after,
        superseded_at, created_at)
     VALUES ($1, $2, $3::classification_label, $4, $5, $6, $7, $8,
             CASE WHEN $9::int IS NULL THEN NULL ELSE NOW() + ($9::int * INTERVAL '1 second') END,
             ${opts.superseded ? 'NOW()' : 'NULL'}, ${createdAt})
     RETURNING id`,
    params,
  );
  return rows[0].id;
}

/** Event + one active classification in one call. */
export async function insertClassifiedEvent(
  opts: Parameters<typeof insertEvent>[0] & {
    label: Label;
    confidence?: number;
    method?: 'deterministic' | 'counterparty' | 'pattern' | 'model';
    source?: 'user' | 'failure' | null;
  },
): Promise<EventFx & { classificationId: string }> {
  const ev = await insertEvent(opts);
  const classificationId = await insertClassification({
    eventId: ev.id,
    userId: ev.userId,
    label: opts.label,
    confidence: opts.confidence,
    method: opts.method,
    source: opts.source,
  });
  return { ...ev, classificationId };
}

export async function insertCorrection(opts: {
  userId: string;
  type?: 'tx' | 'counterparty';
  eventId?: string | null;
  counterpartyAddress?: string | null;
  oldLabel?: Label | null;
  newLabel: Label;
  reason?: string | null;
  classificationId?: string | null;
  oldConfidence?: number | null;
  createdRule?: boolean;
  failureReason?: 'bad_rule' | 'missing_counterparty' | 'bad_model_inference' | 'missing_protocol' | 'bad_data' | null;
  createdAt?: At;
}): Promise<string> {
  const params: unknown[] = [
    opts.userId,
    opts.type ?? 'tx',
    opts.eventId ?? null,
    opts.counterpartyAddress ?? null,
    opts.oldLabel ?? null,
    opts.newLabel,
    opts.reason ?? null,
    opts.classificationId ?? null,
    opts.oldConfidence ?? null,
    opts.createdRule ?? false,
    opts.failureReason ?? null,
  ];
  let createdAt = 'NOW()';
  if (opts.createdAt !== undefined) {
    params.push(opts.createdAt);
    createdAt = atExpr(opts.createdAt, params.length);
  }
  const rows = await sql<{ id: string }>(
    `INSERT INTO corrections
       (user_id, type, event_id, counterparty_address, old_label, new_label, reason,
        classification_id, old_confidence, created_rule, failure_reason, created_at)
     VALUES ($1, $2, $3, $4, $5::classification_label, $6::classification_label, $7,
             $8, $9, $10, $11::correction_failure_reason, ${createdAt})
     RETURNING id`,
    params,
  );
  return rows[0].id;
}

export async function insertCounterpartyRule(opts: {
  userId: string;
  address: string;
  label: Label;
  name?: string | null;
  direction?: 'in' | 'out' | null;
  confidence?: number;
  source?: string;
}): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO counterparty_rules (user_id, address, label, name, confidence, source, direction)
     VALUES ($1, $2, $3::classification_label, $4, $5, $6, $7) RETURNING id`,
    [
      opts.userId,
      opts.address.toLowerCase(),
      opts.label,
      opts.name ?? null,
      opts.confidence ?? 1.0,
      opts.source ?? 'user',
      opts.direction ?? null,
    ],
  );
  return rows[0].id;
}

export type AlertType =
  | 'new_counterparty' | 'spend_spike' | 'treasury_floor' | 'round_trip' | 'unknown_high'
  | 'large_inflow' | 'large_outflow' | 'unusual_gas' | 'x402_anomaly' | 'classifier_degradation'
  | 'portfolio_up' | 'portfolio_down' | 'pnl_positive' | 'books_attention';

export async function insertAlert(opts: {
  userId: string;
  type: AlertType;
  message?: string;
  evidence?: Record<string, unknown> | null;
  dedupKey?: string | null;
  createdAt?: At;
  sentAt?: At | null;
}): Promise<string> {
  const params: unknown[] = [
    opts.userId,
    opts.type,
    opts.message ?? `fixture ${opts.type}`,
    opts.evidence == null ? null : JSON.stringify(opts.evidence),
    opts.dedupKey === undefined ? `fixture:${opts.type}:${next()}` : opts.dedupKey,
  ];
  let createdAt = 'NOW()';
  if (opts.createdAt !== undefined) {
    params.push(opts.createdAt);
    createdAt = atExpr(opts.createdAt, params.length);
  }
  let sentAt = 'NULL';
  if (opts.sentAt != null) {
    params.push(opts.sentAt);
    sentAt = atExpr(opts.sentAt, params.length);
  }
  const rows = await sql<{ id: string }>(
    `INSERT INTO alerts (user_id, type, message, evidence, dedup_key, created_at, sent_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, ${createdAt}, ${sentAt}) RETURNING id`,
    params,
  );
  return rows[0].id;
}

export async function insertBrief(opts: {
  userId: string;
  type: 'daily' | 'weekly' | 'anomaly';
  content?: string;
  createdAt?: At;
  sentAt?: At | null;
  telegramMessageId?: number | null;
}): Promise<string> {
  const params: unknown[] = [
    opts.userId,
    opts.type,
    opts.content ?? 'fixture brief',
    opts.telegramMessageId ?? (opts.sentAt != null ? 1 : null),
  ];
  let createdAt = 'NOW()';
  if (opts.createdAt !== undefined) {
    params.push(opts.createdAt);
    createdAt = atExpr(opts.createdAt, params.length);
  }
  let sentAt = 'NULL';
  if (opts.sentAt != null) {
    params.push(opts.sentAt);
    sentAt = atExpr(opts.sentAt, params.length);
  }
  const rows = await sql<{ id: string }>(
    `INSERT INTO briefs (user_id, type, content, telegram_message_id, created_at, sent_at)
     VALUES ($1, $2, $3, $4, ${createdAt}, ${sentAt}) RETURNING id`,
    params,
  );
  return rows[0].id;
}

/** Common setup: one user with one active wallet (+ active watch job). */
export async function seedUserWithWallet(
  userOpts: Parameters<typeof insertUser>[0] = {},
): Promise<{ user: UserFx; wallet: WalletFx }> {
  const user = await insertUser(userOpts);
  const wallet = await insertWallet({ userId: user.id });
  await insertWatchJob({ userId: user.id, walletId: wallet.id, lastSyncedAt: '5 minutes' });
  return { user, wallet };
}
