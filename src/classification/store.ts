import { pool, query } from '../db.js';
import type { ClassificationLabel, ClassificationMethod } from '../types/index.js';
import type { UnclassifiedEvent, CounterpartyRuleRow, ClassificationFailure } from './types.js';

// A failure placeholder stops being retried after this many counted attempts
// (paid-but-invalid LLM output or permanent request rejection).
export const MAX_CLASSIFICATION_ATTEMPTS = 5;

// Backoff before a failure placeholder becomes eligible for retry.
// Counted failures back off exponentially (30m, 1h, 2h, … capped at 24h);
// uncounted ones (no key, spend cap, transient errors) retry hourly.
export function failureBackoffSeconds(attempts: number, countsAsAttempt: boolean): number {
  if (!countsAsAttempt) return 60 * 60;
  const exp = Math.max(0, attempts - 1);
  return Math.min(30 * 60 * 2 ** exp, 24 * 60 * 60);
}

// Events with no active classification, plus failure placeholders whose backoff has
// elapsed and that still have attempts left. Never-classified events come first so a
// backlog of retries can't starve new events.
export async function getUnclassifiedEvents(
  userId: string,
  limit = 200,
): Promise<UnclassifiedEvent[]> {
  const res = await query<UnclassifiedEvent>(
    `SELECT ne.id, ne.user_id, ne.wallet_id, ne.hash, ne.log_index, ne.source_key, ne.block_time,
            ne.from_address, ne.to_address, ne.asset, ne.amount, ne.direction,
            c.id AS active_classification_id
     FROM normalized_events ne
     LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1
       AND ne.supported IS TRUE
       AND (
         c.id IS NULL
         OR (
           c.source = 'failure'
           AND c.attempts < $3
           AND (c.retry_after IS NULL OR c.retry_after <= NOW())
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM classifications o
         WHERE o.event_id = ne.id AND o.superseded_at IS NULL
           AND o.source IS DISTINCT FROM 'failure'
       )
     ORDER BY (c.id IS NOT NULL) ASC, ne.block_time ASC
     LIMIT $2`,
    [userId, limit, MAX_CLASSIFICATION_ATTEMPTS],
  );
  return res.rows;
}

export async function getUserWalletAddresses(userId: string): Promise<string[]> {
  const res = await query<{ address: string }>(
    `SELECT address FROM wallets WHERE user_id = $1 AND active = TRUE`,
    [userId],
  );
  return res.rows.map((r) => r.address);
}

export async function getCounterpartyRules(userId: string): Promise<CounterpartyRuleRow[]> {
  const res = await query<CounterpartyRuleRow>(
    `SELECT address, label, name, confidence, direction FROM counterparty_rules WHERE user_id = $1`,
    [userId],
  );
  return res.rows;
}

export type SaveClassificationRow = {
  event_id: string;
  user_id: string;
  label: ClassificationLabel;
  confidence: number;
  method: ClassificationMethod;
  evidence: string;
  // Set → store a retryable failure placeholder instead of a real classification
  failure?: ClassificationFailure;
  // Active classification id seen when the event was read (null = none). When provided,
  // the row is skipped if the event's active classification changed in the meantime.
  expected_active_id?: string | null;
};

type ActiveRow = { id: string; source: string | null; attempts: number };

export async function saveClassification(params: {
  event_id: string;
  user_id: string;
  label: ClassificationLabel;
  confidence: number;
  method: ClassificationMethod;
  evidence: string;
}): Promise<void> {
  await saveManyClassifications([params]);
}

// Saves automated classifications. Never supersedes a user correction, and (when
// expected_active_id is given) never overwrites a classification written after the
// event was read — e.g. a correction the user made while the LLM call was in flight.
// Returns the number of rows actually written.
export async function saveManyClassifications(results: SaveClassificationRow[]): Promise<number> {
  if (results.length === 0) return 0;
  // Lock events in a stable order so concurrent workers can't deadlock
  const ordered = [...results].sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
  let written = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of ordered) {
      // Serialise with applyCorrection, which takes the same lock
      const locked = await client.query(
        `SELECT id FROM normalized_events WHERE id = $1 FOR UPDATE`,
        [r.event_id],
      );
      if (locked.rows.length === 0) continue; // event deleted meanwhile

      const activeRes = await client.query<ActiveRow>(
        `SELECT id, source, attempts FROM classifications
         WHERE event_id = $1 AND superseded_at IS NULL
         ORDER BY created_at DESC`,
        [r.event_id],
      );
      const active = activeRes.rows;

      if (active.some((a) => a.source === 'user')) continue;

      if (r.expected_active_id !== undefined) {
        const unchanged =
          r.expected_active_id === null
            ? active.length === 0
            : active.length === 1 && active[0].id === r.expected_active_id;
        if (!unchanged) continue;
      }

      if (r.failure) {
        const prevFailure = active.length === 1 && active[0].source === 'failure' ? active[0] : null;
        const attempts = (prevFailure?.attempts ?? 0) + (r.failure.countsAsAttempt ? 1 : 0);
        const backoff = failureBackoffSeconds(attempts, r.failure.countsAsAttempt);
        if (prevFailure) {
          // Update in place — retries must not grow the table
          await client.query(
            `UPDATE classifications
             SET attempts = $2, retry_after = NOW() + ($3::int * INTERVAL '1 second'), evidence = $4
             WHERE id = $1`,
            [prevFailure.id, attempts, backoff, r.failure.reason],
          );
        } else {
          await client.query(
            `UPDATE classifications SET superseded_at = NOW()
             WHERE event_id = $1 AND superseded_at IS NULL`,
            [r.event_id],
          );
          await client.query(
            `INSERT INTO classifications
               (event_id, user_id, label, confidence, method, evidence, source, attempts, retry_after)
             VALUES ($1, $2, 'unknown', 0, 'model', $3, 'failure', $4,
                     NOW() + ($5::int * INTERVAL '1 second'))`,
            [r.event_id, r.user_id, r.failure.reason, attempts, backoff],
          );
        }
        written++;
        continue;
      }

      await client.query(
        `UPDATE classifications SET superseded_at = NOW()
         WHERE event_id = $1 AND superseded_at IS NULL`,
        [r.event_id],
      );
      await client.query(
        `INSERT INTO classifications (event_id, user_id, label, confidence, method, evidence)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.event_id, r.user_id, r.label, r.confidence, r.method, r.evidence],
      );
      written++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return written;
}

// Users with at least one monitored wallet, including wallets whose last sync errored,
// so a sync failure never pauses a user's classification, alerts or heartbeat.
export async function getDistinctUserIds(): Promise<string[]> {
  const res = await query<{ user_id: string }>(
    `SELECT DISTINCT wj.user_id
     FROM watch_jobs wj
     JOIN wallets w ON w.id = wj.wallet_id
     WHERE wj.status IN ('active', 'error') AND w.active = TRUE`,
  );
  return res.rows.map((r) => r.user_id);
}
