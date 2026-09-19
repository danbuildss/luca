import Fastify from 'fastify';
import { config, requireProductionConfig } from '../../src/config.js';
import { checkDbReady, closeDb, query } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { CLASSIFICATION_LABELS } from '../../src/types/index.js';
import type { ClassificationLabel } from '../../src/types/index.js';
import { applyCorrection, EventNotFoundError } from '../../src/corrections/handler.js';
import { getEventsForReview } from '../../src/corrections/store.js';
import { getBooksSummary, getBooksEvents, getPnlSummary } from '../../src/books/query.js';

if (config.NODE_ENV === 'production') {
  requireProductionConfig();
}

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'key_hash', 'token'],
  },
});

// ---------------------------------------------------------------------------
// Auth helper: V1 trusts x-user-id header (API is localhost-only on VPS)
// ---------------------------------------------------------------------------
function getUserId(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const raw = req.headers['x-user-id'];
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) return null;
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/health', async (_req, reply) => {
  const dbReady = await checkDbReady();
  return reply.status(dbReady ? 200 : 503).send({
    status: dbReady ? 'ok' : 'degraded',
    version: '0.1.0',
    process: 'ok',
    db: dbReady ? 'ok' : 'error',
    env: config.NODE_ENV,
  });
});

// ---------------------------------------------------------------------------
// Events for review: GET /events?label=unknown&limit=50
// ---------------------------------------------------------------------------
app.get('/events', async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.status(401).send({ error: 'x-user-id header required' });

  const { label, limit: limitStr } = req.query as { label?: string; limit?: string };
  const limit = Math.min(parseInt(limitStr ?? '50', 10) || 50, 200);

  if (label && !(CLASSIFICATION_LABELS as readonly string[]).includes(label)) {
    return reply.status(400).send({ error: `Unknown label: ${label}` });
  }

  const events = await getEventsForReview({ userId, label, limit });
  return reply.send({ events });
});

// ---------------------------------------------------------------------------
// Submit correction: POST /corrections
// Body: { event_id, label, reason?, counterparty_name? }
// ---------------------------------------------------------------------------
app.post('/corrections', async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.status(401).send({ error: 'x-user-id header required' });

  const body = req.body as {
    event_id?: string;
    label?: string;
    reason?: string;
    counterparty_name?: string;
  };

  if (!body.event_id || typeof body.event_id !== 'string') {
    return reply.status(400).send({ error: 'event_id required' });
  }
  if (!body.label || !(CLASSIFICATION_LABELS as readonly string[]).includes(body.label)) {
    return reply.status(400).send({ error: `label must be one of: ${CLASSIFICATION_LABELS.join(', ')}` });
  }

  try {
    await applyCorrection({
      userId,
      eventId: body.event_id,
      newLabel: body.label as ClassificationLabel,
      reason: body.reason,
      counterpartyName: body.counterparty_name,
    });
    return reply.status(200).send({ ok: true });
  } catch (err) {
    if (err instanceof EventNotFoundError) {
      return reply.status(404).send({ error: err.message });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Books: GET /books/summary?period=30
// ---------------------------------------------------------------------------
app.get('/books/summary', async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.status(401).send({ error: 'x-user-id header required' });

  const { period: periodStr } = req.query as { period?: string };
  const periodDays = Math.min(parseInt(periodStr ?? '30', 10) || 30, 365);

  const [summary, pnl] = await Promise.all([
    getBooksSummary(userId, periodDays),
    getPnlSummary(userId, periodDays),
  ]);

  return reply.send({ period_days: periodDays, pnl, breakdown: summary });
});

// ---------------------------------------------------------------------------
// Books line items: GET /books/events?label=revenue&period=30&limit=100
// ---------------------------------------------------------------------------
app.get('/books/events', async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.status(401).send({ error: 'x-user-id header required' });

  const { label, period: periodStr, limit: limitStr } = req.query as {
    label?: string;
    period?: string;
    limit?: string;
  };

  if (!label || !(CLASSIFICATION_LABELS as readonly string[]).includes(label)) {
    return reply.status(400).send({ error: `label must be one of: ${CLASSIFICATION_LABELS.join(', ')}` });
  }

  const periodDays = Math.min(parseInt(periodStr ?? '30', 10) || 30, 365);
  const limit = Math.min(parseInt(limitStr ?? '100', 10) || 100, 500);

  const events = await getBooksEvents({ userId, label, periodDays, limit });
  return reply.send({ events });
});

// ---------------------------------------------------------------------------
// Wallet balances: GET /balances
// ---------------------------------------------------------------------------
app.get('/balances', async (req, reply) => {
  const userId = getUserId(req);
  if (!userId) return reply.status(401).send({ error: 'x-user-id header required' });

  const res = await query<{
    wallet_address: string;
    wallet_label: string | null;
    asset: string;
    balance: string;
    snapshot_at: string;
  }>(
    `SELECT DISTINCT ON (bs.wallet_id, bs.asset)
       w.address AS wallet_address,
       w.label   AS wallet_label,
       bs.asset,
       bs.balance::text AS balance,
       bs.snapshot_at::text
     FROM balance_snapshots bs
     JOIN wallets w ON w.id = bs.wallet_id
     WHERE bs.user_id = $1
     ORDER BY bs.wallet_id, bs.asset, bs.snapshot_at DESC`,
    [userId],
  );
  return reply.send({ balances: res.rows });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
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
