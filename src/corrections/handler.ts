import { pool } from '../db.js';
import { ClassificationLabel } from '../types/index.js';
import { getEventWithClassification, upsertCounterpartyRule } from './store.js';

export type FailureReason =
  | 'bad_rule'
  | 'missing_counterparty'
  | 'bad_model_inference'
  | 'missing_protocol'
  | 'bad_data';

export type ApplyCorrectionParams = {
  userId: string;
  eventId: string;
  newLabel: ClassificationLabel;
  reason?: string;
  counterpartyName?: string;
  failureReason?: FailureReason;
};

export type CorrectionResult = {
  correctionId: string;
  wasCorrection: boolean; // true when old label existed and differed from new label
};

export class EventNotFoundError extends Error {
  constructor(eventId: string) {
    super(`Event ${eventId} not found for user`);
    this.name = 'EventNotFoundError';
  }
}

export async function applyCorrection(params: ApplyCorrectionParams): Promise<CorrectionResult> {
  const event = await getEventWithClassification(params.eventId, params.userId);
  if (!event) throw new EventNotFoundError(params.eventId);

  const counterparty = event.direction === 'in' ? event.from_address : event.to_address;
  const oldLabel = event.current_label ?? null;
  const oldClassificationId = event.current_classification_id ?? null;
  const oldConfidence = event.current_confidence ?? null;
  const evidence = `User correction: ${params.reason ?? 'manual label'}`;
  const wasCorrection = oldLabel !== null && oldLabel !== params.newLabel;

  const client = await pool.connect();
  let correctionId: string;
  try {
    await client.query('BEGIN');

    // Same lock the classifier's save path takes — serialises a correction with an
    // in-flight automated save so neither silently overwrites the other.
    await client.query(
      `SELECT id FROM normalized_events WHERE id = $1 FOR UPDATE`,
      [params.eventId],
    );

    await client.query(
      `UPDATE classifications SET superseded_at = NOW()
       WHERE event_id = $1 AND superseded_at IS NULL`,
      [params.eventId],
    );

    // source = 'user' marks this as a correction; automated classifiers never supersede it
    await client.query(
      `INSERT INTO classifications (event_id, user_id, label, confidence, method, evidence, source)
       VALUES ($1, $2, $3, 1.0, 'counterparty', $4, 'user')`,
      [params.eventId, params.userId, params.newLabel, evidence],
    );

    const createdRule = counterparty !== null && counterparty !== undefined;
    const corrRes = await client.query<{ id: string }>(
      `INSERT INTO corrections
         (user_id, type, event_id, counterparty_address, old_label, new_label, reason,
          classification_id, old_confidence, created_rule, failure_reason)
       VALUES ($1, 'tx', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        params.userId, params.eventId, counterparty, oldLabel, params.newLabel,
        params.reason ?? null, oldClassificationId, oldConfidence, createdRule,
        params.failureReason ?? null,
      ],
    );
    correctionId = corrRes.rows[0].id;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Upsert rule outside the transaction — idempotent, OK if it fails after commit.
  // The rule is scoped to the event's direction: labelling a customer's payment as
  // revenue must not auto-label a refund we later send them.
  if (counterparty) {
    await upsertCounterpartyRule({
      userId: params.userId,
      address: counterparty,
      label: params.newLabel,
      name: params.counterpartyName ?? null,
      direction: event.direction,
    });
  }

  return { correctionId, wasCorrection };
}
