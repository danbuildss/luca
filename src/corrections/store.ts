import { query } from '../db.js';
import type { ClassificationLabel } from '../types/index.js';
import type { FailureReason } from './handler.js';

export type EventWithClassification = {
  id: string;
  direction: 'in' | 'out';
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: number | null;
  current_label: ClassificationLabel | null;
  current_classification_id: string | null;
  current_confidence: number | null;
};

export async function getEventWithClassification(
  eventId: string,
  userId: string,
): Promise<EventWithClassification | null> {
  const res = await query<EventWithClassification>(
    `SELECT ne.id, ne.direction, ne.from_address, ne.to_address, ne.asset, ne.amount,
            c.label AS current_label,
            c.id    AS current_classification_id,
            c.confidence AS current_confidence
     FROM normalized_events ne
     LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.id = $1 AND ne.user_id = $2`,
    [eventId, userId],
  );
  return res.rows[0] ?? null;
}

// direction: the event direction the rule applies to ('in' | 'out').
// Omitted/null = legacy any-direction rule (e.g. a counterparty-level label).
export async function upsertCounterpartyRule(params: {
  userId: string;
  address: string;
  label: ClassificationLabel;
  name: string | null;
  direction?: 'in' | 'out' | null;
}): Promise<void> {
  await query(
    `INSERT INTO counterparty_rules (user_id, address, label, name, confidence, source, direction)
     VALUES ($1, $2, $3, $4, 1.0, 'user', $5::text)
     ON CONFLICT (user_id, address, (COALESCE(direction, '*'))) DO UPDATE
       SET label      = EXCLUDED.label,
           name       = COALESCE(EXCLUDED.name, counterparty_rules.name),
           confidence = 1.0,
           source     = 'user',
           updated_at = NOW()`,
    [params.userId, params.address.toLowerCase(), params.label, params.name, params.direction ?? null],
  );
}

export type ReviewEvent = {
  id: string;
  hash: string;
  block_time: Date;
  from_address: string;
  to_address: string | null;
  asset: string | null;
  amount: number | null;
  direction: 'in' | 'out';
  label: string | null;
  confidence: number | null;
};

export async function setFailureReason(
  correctionId: string,
  userId: string,
  failureReason: FailureReason,
): Promise<void> {
  await query(
    `UPDATE corrections SET failure_reason = $1
     WHERE id = $2 AND user_id = $3`,
    [failureReason, correctionId, userId],
  );
}

export async function getEventsForReview(params: {
  userId: string;
  label?: string;
  limit?: number;
}): Promise<ReviewEvent[]> {
  const { userId, label = null, limit = 50 } = params;
  const res = await query<ReviewEvent>(
    `SELECT ne.id, ne.hash, ne.block_time, ne.from_address, ne.to_address,
            ne.asset, ne.amount, ne.direction,
            c.label, c.confidence
     FROM normalized_events ne
     LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1
       AND ($2::text IS NULL OR c.label = $2::classification_label)
     ORDER BY ne.block_time DESC
     LIMIT $3`,
    [userId, label, limit],
  );
  return res.rows;
}
