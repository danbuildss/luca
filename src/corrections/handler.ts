import { pool } from '../db.js';
import { ClassificationLabel } from '../types/index.js';
import { getEventWithClassification, upsertCounterpartyRule } from './store.js';

export type ApplyCorrectionParams = {
  userId: string;
  eventId: string;
  newLabel: ClassificationLabel;
  reason?: string;
  counterpartyName?: string;
};

export class EventNotFoundError extends Error {
  constructor(eventId: string) {
    super(`Event ${eventId} not found for user`);
    this.name = 'EventNotFoundError';
  }
}

export async function applyCorrection(params: ApplyCorrectionParams): Promise<void> {
  const event = await getEventWithClassification(params.eventId, params.userId);
  if (!event) throw new EventNotFoundError(params.eventId);

  const counterparty = event.direction === 'in' ? event.from_address : event.to_address;
  const oldLabel = event.current_label ?? null;
  const evidence = `User correction: ${params.reason ?? 'manual label'}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE classifications SET superseded_at = NOW()
       WHERE event_id = $1 AND superseded_at IS NULL`,
      [params.eventId],
    );

    await client.query(
      `INSERT INTO classifications (event_id, user_id, label, confidence, method, evidence)
       VALUES ($1, $2, $3, 1.0, 'counterparty', $4)`,
      [params.eventId, params.userId, params.newLabel, evidence],
    );

    await client.query(
      `INSERT INTO corrections (user_id, type, event_id, counterparty_address, old_label, new_label, reason)
       VALUES ($1, 'tx', $2, $3, $4, $5, $6)`,
      [params.userId, params.eventId, counterparty, oldLabel, params.newLabel, params.reason ?? null],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Upsert rule outside the transaction — idempotent, OK if it fails after commit
  if (counterparty) {
    await upsertCounterpartyRule({
      userId: params.userId,
      address: counterparty,
      label: params.newLabel,
      name: params.counterpartyName ?? null,
    });
  }
}
