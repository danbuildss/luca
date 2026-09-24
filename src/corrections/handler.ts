import { pool } from '../db.js';
import { ClassificationLabel } from '../types/index.js';
import {
  getEventWithClassification, upsertCounterpartyRule, getActiveRule, disableRule, isSwapVenue,
  relabelEvents, eventsForRule, eventsLabeledByRule,
} from './store.js';

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

// What the correction did to the rule for this address and direction.
//   learned    - a rule now labels this address; `relabeled` earlier transfers were updated
//   switched_off - it contradicted an active rule, which is now off; `sentBack` transfers
//                  that rule had labeled are unknown again and will be asked about
//   swap_venue - no rule: the address is an exchange contract
//   none       - no rule (no counterparty, or the label was unknown)
export type RuleOutcome =
  | { kind: 'learned'; relabeled: number }
  | { kind: 'switched_off'; sentBack: number }
  | { kind: 'swap_venue' }
  | { kind: 'none' };

export type CorrectionResult = {
  correctionId: string;
  wasCorrection: boolean; // true when old label existed and differed from new label
  rule: RuleOutcome;
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

  // Decide what happens to the address's rule before writing anything
  const activeRule = counterparty ? await getActiveRule(params.userId, counterparty, event.direction) : null;
  const plan: 'learn' | 'switch_off' | 'swap_venue' | 'none' =
    !counterparty ? 'none'
    : activeRule && activeRule.label !== params.newLabel ? 'switch_off'
    : params.newLabel === ClassificationLabel.UNKNOWN ? 'none'
    : activeRule ? 'learn'
    : await isSwapVenue(params.userId, counterparty) ? 'swap_venue'
    : 'learn';

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

    const createdRule = plan === 'learn';
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

  // Rule changes happen after the correction is committed. The rule is scoped to the
  // event's direction: labelling a customer's payment as revenue must not auto-label a
  // refund we later send them.
  let rule: RuleOutcome = { kind: 'none' };
  if (counterparty && plan === 'learn') {
    const ruleId = await upsertCounterpartyRule({
      userId: params.userId,
      address: counterparty,
      label: params.newLabel,
      name: params.counterpartyName ?? null,
      direction: event.direction,
    });
    // One answer labels them all: earlier transfers to or from this address too
    const earlier = await eventsForRule(params.userId, counterparty, event.direction, params.newLabel, params.eventId);
    const relabeled = await relabelEvents(params.userId, earlier, {
      label: params.newLabel,
      confidence: 1.0,
      method: 'counterparty',
      evidence: `Counterparty "${params.counterpartyName ?? `${counterparty.slice(0, 10)}…`}" matches a rule learned from your answer`,
      shape: 'single',
      rule_id: ruleId,
      source: null,
    });
    rule = { kind: 'learned', relabeled };
  } else if (counterparty && plan === 'switch_off' && activeRule) {
    await disableRule(activeRule.id, params.userId, `Contradicted by a correction to ${params.newLabel}`);
    const labeled = await eventsLabeledByRule(params.userId, activeRule.id, counterparty, event.direction, params.eventId);
    const sentBack = await relabelEvents(params.userId, labeled, {
      label: ClassificationLabel.UNKNOWN,
      confidence: 0,
      method: 'counterparty',
      evidence: `The rule for this address was switched off after you relabeled a transfer as ${params.newLabel}; needs your answer`,
      shape: 'single',
      rule_id: null,
      source: null,
    });
    rule = { kind: 'switched_off', sentBack };
  } else if (plan === 'swap_venue') {
    rule = { kind: 'swap_venue' };
  }

  return { correctionId, wasCorrection, rule };
}

// One sentence for the operator on what happened beyond the transfer itself.
export function describeRuleOutcome(rule: RuleOutcome): string | null {
  switch (rule.kind) {
    case 'learned':
      return rule.relabeled > 0
        ? `Also relabeled ${rule.relabeled} earlier ${rule.relabeled === 1 ? 'transfer' : 'transfers'} with this address, and future ones will be labeled the same way.`
        : 'Future transfers with this address will be labeled the same way.';
    case 'switched_off':
      return rule.sentBack > 0
        ? `That contradicts the rule I had for this address, so I switched it off. ${rule.sentBack} other ${rule.sentBack === 1 ? 'transfer it labeled needs' : 'transfers it labeled need'} your answer; I will ask about them together.`
        : 'That contradicts the rule I had for this address, so I switched it off.';
    case 'swap_venue':
      return 'I did not make a rule for this address because it is an exchange contract.';
    case 'none':
      return null;
  }
}
