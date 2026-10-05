import { pool, query } from '../db.js';
import { ClassificationLabel } from '../types/index.js';
import {
  getEventWithClassification, upsertCounterpartyRule, getActiveRule, disableRule, isSwapVenue,
  eventsForRule, eventsLabeledByRule,
} from './store.js';
import { createProposal, supersedeProposals, type ProposalSummary } from './proposals.js';

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
  // The operator's own words that asked for this change (migration 030)
  sourceMessage?: string | null;
};

// What the correction did to the rule for this address and direction. Earlier transfers
// are never changed here: when the rule would change them, `proposal` is the question to
// ask the operator (src/corrections/proposals.ts), and only a yes changes them.
//   learned      - a rule now labels future transfers with this address
//   switched_off - it contradicted an active rule, which is now off
//   swap_venue   - no rule: the address is an exchange contract
//   none         - no rule (no counterparty, or the label was unknown)
export type RuleOutcome =
  | { kind: 'learned'; proposal: ProposalSummary | null }
  | { kind: 'switched_off'; proposal: ProposalSummary | null }
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
    const created = await client.query<{ id: string }>(
      `INSERT INTO classifications (event_id, user_id, label, confidence, method, evidence, source)
       VALUES ($1, $2, $3, 1.0, 'counterparty', $4, 'user')
       RETURNING id`,
      [params.eventId, params.userId, params.newLabel, evidence],
    );

    const createdRule = plan === 'learn';
    const corrRes = await client.query<{ id: string }>(
      `INSERT INTO corrections
         (user_id, type, event_id, counterparty_address, old_label, new_label, reason,
          classification_id, old_confidence, created_rule, failure_reason, new_classification_id, source_message)
       VALUES ($1, 'tx', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        params.userId, params.eventId, counterparty, oldLabel, params.newLabel,
        params.reason ?? null, oldClassificationId, oldConfidence, createdRule,
        params.failureReason ?? null, created.rows[0].id, params.sourceMessage?.slice(0, 2000) ?? null,
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
      correctionId,
    });
    // The rule this correction taught
    await query(`UPDATE corrections SET rule_id = $2 WHERE id = $1`, [correctionId, ruleId]);
    // Earlier transfers the rule covers change only if the operator says yes
    const earlier = await eventsForRule(params.userId, counterparty, event.direction, params.newLabel, params.eventId);
    const proposal = await createProposal({
      userId: params.userId, kind: 'apply_rule', ruleId, correctionId, sourceEventId: params.eventId,
      address: counterparty, direction: event.direction, label: params.newLabel, eventIds: earlier,
    });
    rule = { kind: 'learned', proposal };
  } else if (counterparty && plan === 'switch_off' && activeRule) {
    await disableRule(activeRule.id, params.userId, `Contradicted by a correction to ${params.newLabel}`, correctionId);
    // What the switched-off rule labeled goes back to unknown only if the operator says yes
    const labeled = await eventsLabeledByRule(params.userId, activeRule.id, counterparty, event.direction, params.eventId);
    const proposal = await createProposal({
      userId: params.userId, kind: 'send_back', ruleId: activeRule.id, correctionId, sourceEventId: params.eventId,
      address: counterparty, direction: event.direction, label: activeRule.label, eventIds: labeled,
    });
    rule = { kind: 'switched_off', proposal };
  } else if (plan === 'swap_venue') {
    rule = { kind: 'swap_venue' };
  }
  // A new answer for this address replaces any question still open about it
  if (counterparty && rule.kind !== 'learned' && rule.kind !== 'switched_off') {
    await supersedeProposals(params.userId, counterparty, event.direction);
  }

  return { correctionId, wasCorrection, rule };
}

// What happened beyond the transfer itself, for the operator. When earlier transfers would
// change, it ends with the question (each transfer with its BaseScan link); nothing earlier
// has changed yet.
export function describeRuleOutcome(rule: RuleOutcome): string | null {
  switch (rule.kind) {
    case 'learned':
      return rule.proposal
        ? `New transfers with this address will be labeled the same way. I haven't changed any earlier ones.\n\n${rule.proposal.question}`
        : 'New transfers with this address will be labeled the same way.';
    case 'switched_off':
      return rule.proposal
        ? `That contradicts the rule I had for this address, so I switched it off.\n\n${rule.proposal.question}`
        : 'That contradicts the rule I had for this address, so I switched it off.';
    case 'swap_venue':
      return 'I did not make a rule for this address because it is an exchange contract.';
    case 'none':
      return null;
  }
}
