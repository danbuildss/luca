import { pool, query } from '../db.js';
import type { ClassificationLabel, ClassificationMethod } from '../types/index.js';
import type { UnclassifiedEvent, CounterpartyRuleRow } from './types.js';

export async function getUnclassifiedEvents(
  userId: string,
  limit = 200,
): Promise<UnclassifiedEvent[]> {
  const res = await query<UnclassifiedEvent>(
    `SELECT ne.id, ne.user_id, ne.wallet_id, ne.hash, ne.log_index, ne.block_time,
            ne.from_address, ne.to_address, ne.asset, ne.amount, ne.direction
     FROM normalized_events ne
     WHERE ne.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM classifications c
         WHERE c.event_id = ne.id AND c.superseded_at IS NULL
       )
     ORDER BY ne.block_time ASC
     LIMIT $2`,
    [userId, limit],
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
    `SELECT address, label, name, confidence FROM counterparty_rules WHERE user_id = $1`,
    [userId],
  );
  return res.rows;
}

export async function saveClassification(params: {
  event_id: string;
  user_id: string;
  label: ClassificationLabel;
  confidence: number;
  method: ClassificationMethod;
  evidence: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Supersede any existing active classification for this event
    await client.query(
      `UPDATE classifications SET superseded_at = NOW()
       WHERE event_id = $1 AND superseded_at IS NULL`,
      [params.event_id],
    );
    await client.query(
      `INSERT INTO classifications (event_id, user_id, label, confidence, method, evidence)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [params.event_id, params.user_id, params.label, params.confidence, params.method, params.evidence],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function saveManyClassifications(
  results: Array<{
    event_id: string;
    user_id: string;
    label: ClassificationLabel;
    confidence: number;
    method: ClassificationMethod;
    evidence: string;
  }>,
): Promise<void> {
  if (results.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of results) {
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
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getDistinctUserIds(): Promise<string[]> {
  const res = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM watch_jobs WHERE status = 'active'`,
  );
  return res.rows.map((r) => r.user_id);
}
