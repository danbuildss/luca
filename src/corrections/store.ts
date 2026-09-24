import { query } from '../db.js';
import type { ClassificationLabel } from '../types/index.js';
import type { FailureReason } from './handler.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A full transaction hash, or a shortened one like "0x619bde94…" (at least 8 hex digits)
const TX_HASH_PREFIX_RE = /^0x[0-9a-f]{8,64}$/i;

export type EventCandidate = { id: string; hash: string; direction: 'in' | 'out'; asset: string | null; amount: string | null };

export type EventRefResolution =
  | { status: 'found'; event: EventCandidate }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: EventCandidate[] };

// Resolves what a user or the agent calls a transaction (Luca's event UUID, or a full or
// shortened tx hash) to one of this user's supported events.
export async function resolveEventRef(userId: string, ref: string): Promise<EventRefResolution> {
  const cleaned = ref.trim().replace(/[.…]+$/u, '');
  let rows: EventCandidate[];
  if (UUID_RE.test(cleaned)) {
    rows = (await query<EventCandidate>(
      `SELECT id, hash, direction, asset, amount::text AS amount FROM normalized_events
       WHERE id = $1 AND user_id = $2 AND supported IS TRUE`,
      [cleaned, userId],
    )).rows;
  } else if (TX_HASH_PREFIX_RE.test(cleaned)) {
    rows = (await query<EventCandidate>(
      `SELECT id, hash, direction, asset, amount::text AS amount FROM normalized_events
       WHERE user_id = $1 AND supported IS TRUE AND LOWER(hash) LIKE $2
       ORDER BY block_time DESC
       LIMIT 5`,
      [userId, `${cleaned.toLowerCase()}%`],
    )).rows;
  } else {
    return { status: 'not_found' };
  }
  if (rows.length === 0) return { status: 'not_found' };
  if (rows.length > 1) return { status: 'ambiguous', candidates: rows };
  return { status: 'found', event: rows[0] };
}

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
  if (!UUID_RE.test(eventId)) return null;
  const res = await query<EventWithClassification>(
    `SELECT ne.id, ne.direction, ne.from_address, ne.to_address, ne.asset, ne.amount,
            c.label AS current_label,
            c.id    AS current_classification_id,
            c.confidence AS current_confidence
     FROM normalized_events ne
     LEFT JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.id = $1 AND ne.user_id = $2 AND ne.supported IS TRUE`,
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
       AND ne.supported IS TRUE
       AND ($2::text IS NULL OR c.label = $2::classification_label)
     ORDER BY ne.block_time DESC
     LIMIT $3`,
    [userId, label, limit],
  );
  return res.rows;
}
