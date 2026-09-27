import { query } from '../db.js';
import { logger } from '../logger.js';
import { ClassificationLabel } from '../types/index.js';
import { txLink, shortHash } from '../ledger/links.js';
import { significant } from '../books/breakdown.js';
import { relabelEvents, eventsForRule, eventsLabeledByRule } from './store.js';

// Changing earlier entries in the books always needs the operator's yes. A correction that
// teaches a rule (or switches one off) no longer rewrites earlier transfers by itself: it
// stores a proposal listing exactly the transfers it would change and asks. Only an
// accepted proposal changes them, and only those that still qualify at that moment.
// See migrations/023_label_proposals.sql.

export type ProposalKind = 'apply_rule' | 'send_back';

export type Proposal = {
  id: string;
  kind: ProposalKind;
  rule_id: string | null;
  source_event_id: string | null;
  counterparty_address: string;
  direction: 'in' | 'out';
  label: ClassificationLabel;
  event_ids: string[];
  question: string;
  created_at: Date;
};

export type ProposalSummary = { id: string; count: number; question: string };

// Anything Luca asked and is waiting on: a rule proposal, or a change the operator asked
// for in chat (kind 'changes', src/agent/changes.ts; migration 024)
export type OpenQuestion = { id: string; kind: ProposalKind | 'changes'; question: string; created_at: Date };

const LABEL_WORDS: Record<string, string> = {
  revenue: 'revenue', expense: 'expense', internal_transfer: 'internal transfer', treasury: 'treasury',
  gas: 'network fee', x402_income: 'x402 income', x402_spend: 'x402 spend', refund: 'refund',
  swap: 'swap', unknown: 'unknown',
};
export const labelWords = (l: string): string => LABEL_WORDS[l] ?? l;

function transfersNoun(direction: 'in' | 'out', n: number, address: string): string {
  const who = shortHash(address);
  return direction === 'out'
    ? `${n === 1 ? 'payment' : 'payments'} to ${who}`
    : `${n === 1 ? 'transfer' : 'transfers'} from ${who}`;
}

const MAX_LISTED = 5;

// "I found 6 earlier payments to 0xabc…1234 that this rule also covers: 5 labeled expense,
// 1 unknown. Want me to label them revenue too?" and the transfers, each with its link.
async function buildQuestion(p: {
  userId: string; kind: ProposalKind; address: string; direction: 'in' | 'out'; label: string; eventIds: string[];
}): Promise<string> {
  const rows = await query<{ hash: string; block_time: Date; asset: string | null; amount: string | null; label: string }>(
    `SELECT ne.hash, ne.block_time, ne.asset, ne.amount::text AS amount, c.label::text AS label
     FROM normalized_events ne
     JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
     WHERE ne.user_id = $1 AND ne.id = ANY($2::uuid[])
     ORDER BY ne.block_time DESC`,
    [p.userId, p.eventIds],
  );
  const tz = (await query<{ timezone: string | null }>(`SELECT timezone FROM users WHERE id = $1`, [p.userId])).rows[0]?.timezone ?? 'UTC';
  const day = (d: Date): string => {
    try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz }); }
    catch { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  };
  const n = rows.rows.length;
  const what = `${n} earlier ${transfersNoun(p.direction, n, p.address)}`;
  const them = n === 1 ? 'it' : 'them';

  let head: string;
  if (p.kind === 'apply_rule') {
    const counts = new Map<string, number>();
    for (const r of rows.rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
    const now = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([l, c]) => (l === 'unknown' ? `${c} unknown` : `${c} labeled ${labelWords(l)}`)).join(', ');
    head = `I found ${what} that the same rule covers (${now}). Want me to label ${them} ${labelWords(p.label)} too?`;
  } else {
    head = `That rule had labeled ${what} as ${labelWords(p.label)}. Want me to send ${them} back to unknown, so you can tell me what ${n === 1 ? 'it was' : 'each one was'}?`;
  }
  const lines = rows.rows.slice(0, MAX_LISTED).map((r) => {
    const amount = r.amount != null ? `${significant(parseFloat(r.amount))} ${r.asset ?? ''}`.trim() : r.asset ?? '';
    return `- ${day(r.block_time)}  ${amount}  ${txLink(r.hash)}`;
  });
  if (n > MAX_LISTED) lines.push(`- and ${n - MAX_LISTED} more`);
  return [head, ...lines].join('\n');
}

// Any earlier question about this address and direction no longer applies
export async function supersedeProposals(userId: string, address: string, direction: 'in' | 'out'): Promise<void> {
  await query(
    `UPDATE label_proposals SET status = 'superseded', decided_at = NOW()
     WHERE user_id = $1 AND status = 'pending' AND LOWER(counterparty_address) = LOWER($2) AND direction = $3`,
    [userId, address, direction],
  );
}

export async function createProposal(p: {
  userId: string;
  kind: ProposalKind;
  ruleId: string | null;
  correctionId: string | null;
  sourceEventId: string;
  address: string;
  direction: 'in' | 'out';
  label: ClassificationLabel;
  eventIds: string[];
}): Promise<ProposalSummary | null> {
  await supersedeProposals(p.userId, p.address, p.direction);
  if (p.eventIds.length === 0) return null;
  const question = await buildQuestion({ ...p, address: p.address.toLowerCase() });
  const res = await query<{ id: string }>(
    `INSERT INTO label_proposals
       (user_id, kind, rule_id, correction_id, source_event_id, counterparty_address, direction, label, event_ids, question)
     VALUES ($1, $2, $3, $4, $5, LOWER($6), $7, $8, $9::uuid[], $10)
     RETURNING id`,
    [p.userId, p.kind, p.ruleId, p.correctionId, p.sourceEventId, p.address, p.direction, p.label, p.eventIds, question],
  );
  return { id: res.rows[0].id, count: p.eventIds.length, question };
}

// Open questions, oldest first. Expired ones are marked as such on the way.
export async function pendingProposals(userId: string): Promise<OpenQuestion[]> {
  await query(
    `UPDATE label_proposals SET status = 'expired', decided_at = NOW()
     WHERE user_id = $1 AND status = 'pending' AND expires_at <= NOW()`,
    [userId],
  );
  const res = await query<OpenQuestion>(
    `SELECT id, kind, question, created_at
     FROM label_proposals
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY created_at ASC`,
    [userId],
  );
  return res.rows;
}

// Luca asked this question again: it is the current question from now on (created_at is
// when it was last asked; expires_at is unchanged)
export async function reask(userId: string, id: string): Promise<void> {
  await query(
    `UPDATE label_proposals SET created_at = clock_timestamp() WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [id, userId],
  );
}

// A proposal is the one a bare "yes" answers only while the operator has said nothing
// else since it was asked: at most one message of theirs (the answer itself) is newer.
export async function isCurrent(userId: string, p: { created_at: Date }): Promise<boolean> {
  const res = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM conversation_messages
     WHERE user_id = $1 AND role = 'user' AND created_at > $2`,
    [userId, p.created_at],
  );
  return (res.rows[0]?.n ?? 0) <= 1;
}

export type ProposalAnswer =
  | { ok: true; accepted: boolean; changed: number; skipped: number; text: string }
  | { ok: false; reason: 'not_found' | 'not_pending'; text: string };

// Applies (or declines) one of the operator's own pending proposals. Accepting re-checks
// every transfer first: only those that still belong to the operator, still qualify under
// the same rule conditions and were not labeled by the operator since are changed.
export async function answerProposal(p: { userId: string; proposalId: string; accept: boolean }): Promise<ProposalAnswer> {
  const claimed = await query<Proposal & { rule_name: string | null }>(
    `UPDATE label_proposals lp
     SET status = $3, decided_at = NOW()
     WHERE lp.id = $1 AND lp.user_id = $2 AND lp.status = 'pending' AND lp.expires_at > NOW()
       AND lp.kind IN ('apply_rule', 'send_back')
     RETURNING lp.id, lp.kind, lp.rule_id, lp.source_event_id, lp.counterparty_address, lp.direction,
               lp.label::text AS label, lp.event_ids, lp.question, lp.created_at,
               (SELECT name FROM counterparty_rules r WHERE r.id = lp.rule_id) AS rule_name`,
    [p.proposalId, p.userId, p.accept ? 'accepted' : 'declined'],
  );
  const prop = claimed.rows[0];
  if (!prop) {
    const exists = await query<{ status: string }>(
      `SELECT status FROM label_proposals WHERE id = $1 AND user_id = $2`, [p.proposalId, p.userId],
    );
    return exists.rows[0]
      ? { ok: false, reason: 'not_pending', text: "That question is no longer open, so I haven't changed anything." }
      : { ok: false, reason: 'not_found', text: "I don't have that question open, so I haven't changed anything." };
  }

  const n = prop.event_ids.length;
  const noun = transfersNoun(prop.direction, n, prop.counterparty_address);
  if (!p.accept) {
    const text = prop.kind === 'apply_rule'
      ? `OK, I left the ${n} earlier ${noun} as they were. New ones will still be labeled ${labelWords(prop.label)}.`
      : `OK, I left the ${n} earlier ${noun} as they were.`;
    await query(`UPDATE label_proposals SET result = $2 WHERE id = $1`, [prop.id, JSON.stringify({ changed: 0, skipped: 0 })]);
    return { ok: true, accepted: false, changed: 0, skipped: 0, text };
  }

  // Still qualifying, by the same conditions the proposal was built with
  const ids = new Set(prop.event_ids);
  const except = prop.source_event_id ?? '00000000-0000-0000-0000-000000000000';
  let changed = 0;
  if (prop.kind === 'apply_rule') {
    const ruleActive = prop.rule_id
      ? (await query<{ active: boolean }>(`SELECT active FROM counterparty_rules WHERE id = $1 AND user_id = $2`, [prop.rule_id, p.userId])).rows[0]?.active === true
      : false;
    const still = ruleActive
      ? (await eventsForRule(p.userId, prop.counterparty_address, prop.direction, prop.label, except)).filter((id) => ids.has(id))
      : [];
    const name = prop.rule_name ?? `${prop.counterparty_address.slice(0, 10)}…`;
    changed = await relabelEvents(p.userId, still, {
      label: prop.label, confidence: 1.0, method: 'counterparty',
      evidence: `Counterparty "${name}" matches a rule learned from your answer; you approved updating earlier transfers`,
      shape: 'single', rule_id: prop.rule_id, source: null,
    });
  } else {
    const still = prop.rule_id
      ? (await eventsLabeledByRule(p.userId, prop.rule_id, prop.counterparty_address, prop.direction, except)).filter((id) => ids.has(id))
      : [];
    changed = await relabelEvents(p.userId, still, {
      label: ClassificationLabel.UNKNOWN, confidence: 0, method: 'counterparty',
      evidence: `The rule for this address was switched off and you asked to re-check its transfers; needs your answer`,
      shape: 'single', rule_id: null, source: null,
    });
  }
  const skipped = n - changed;
  await query(`UPDATE label_proposals SET result = $2 WHERE id = $1`, [prop.id, JSON.stringify({ changed, skipped })]);
  logger.info({ userId: p.userId, proposalId: prop.id, kind: prop.kind, changed, skipped }, 'Label proposal accepted');

  const why = (k: number): string => k === 1
    ? 'it changed since I asked (you labeled it yourself, or it no longer matches the rule)'
    : 'they changed since I asked (you labeled them yourself, or they no longer match the rule)';
  let text: string;
  if (changed === 0) {
    text = `I didn't change anything: ${n === 1 ? why(1) : `all ${n} of ${why(n).replace(/^they /, 'them ')}`}.`;
  } else {
    const changedNoun = transfersNoun(prop.direction, changed, prop.counterparty_address);
    const verb = changed === 1 ? 'is' : 'are';
    text = prop.kind === 'apply_rule'
      ? `Done. ${changed} earlier ${changedNoun} ${verb} now ${labelWords(prop.label)}.`
      : `Done. ${changed} earlier ${changedNoun} ${verb} back to unknown, and I'll ask you about ${changed === 1 ? 'it' : 'them'}.`;
    if (skipped > 0) text += ` I left ${skipped} alone because ${why(skipped)}.`;
  }
  return { ok: true, accepted: true, changed, skipped, text };
}
