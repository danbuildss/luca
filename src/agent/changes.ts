import { query } from '../db.js';
import { logger } from '../logger.js';
import type { ClassificationLabel } from '../types/index.js';
import { txLink } from '../ledger/links.js';
import { significant, usdDisplay } from '../books/breakdown.js';
import { answerProposal, labelWords, type ProposalAnswer } from '../corrections/proposals.js';
import { describeRuleOutcome } from '../corrections/handler.js';
import { labelQuestionGroup } from '../alerts/questions.js';
import { prepareWriteAction, executeTool } from './tools.js';

// Changes the operator asks for in chat ("0x4586… was revenue", "track wallet 0x…",
// "those 4 payments are expenses") never happen on the model's word. The model's tool
// call is validated and turned into one question in Luca's own fixed wording; the change
// waits in label_proposals (kind 'changes', migration 024) until the operator answers
// (src/agent/proposals-chat.ts), and is validated again before it is applied.

export type ChangeTool = 'apply_correction' | 'register_wallet' | 'label_question_group';
export const CHANGE_TOOLS: ReadonlySet<string> = new Set<ChangeTool>(['apply_correction', 'register_wallet', 'label_question_group']);

export type ChangeAction = {
  tool: ChangeTool;
  args: Record<string, unknown>;
  ask: string;   // "Label the 0.0014997 ETH you received on Sep 27 (0x4586…1155) as revenue"
  done: string;  // "Labeled the 0.0014997 ETH you received on Sep 27 (0x4586…1155) as revenue"
};

// Pending changes wait a day; after that the operator asks again
const CHANGES_TTL = '24 hours';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const quoted = (v: string, max = 60): string => `"${v.replace(/["\n\r]/g, ' ').slice(0, max)}"`;
const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

async function dayIn(userId: string): Promise<(d: Date) => string> {
  const tz = (await query<{ timezone: string | null }>(`SELECT timezone FROM users WHERE id = $1`, [userId])).rows[0]?.timezone ?? 'UTC';
  return (d: Date) => {
    try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz }); }
    catch { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  };
}

// The wording of one validated change, from the database, never from the model's text
export async function describeChange(userId: string, tool: ChangeTool, args: Record<string, unknown>): Promise<ChangeAction> {
  const day = await dayIn(userId);
  if (tool === 'apply_correction') {
    const ev = (await query<{ hash: string; direction: 'in' | 'out'; asset: string | null; amount: string | null; block_time: Date }>(
      `SELECT hash, direction, asset, amount::text AS amount, block_time FROM normalized_events WHERE id = $1 AND user_id = $2`,
      [args.event_id, userId],
    )).rows[0];
    const amount = ev?.amount != null ? `${significant(parseFloat(ev.amount))} ${ev.asset ?? ''}`.trim() : ev?.asset ?? 'transfer';
    const what = ev
      ? `the ${amount} you ${ev.direction === 'in' ? 'received' : 'sent'} on ${day(ev.block_time)} (${txLink(ev.hash)})`
      : 'that transfer';
    const label = labelWords(String(args.new_label));
    const name = str(args.counterparty_name);
    const naming = name && ev ? `, and call the ${ev.direction === 'in' ? 'sender' : 'recipient'} ${quoted(name)}` : '';
    return { tool, args, ask: `Label ${what} as ${label}${naming}`, done: `Labeled ${what} as ${label}${naming.replace(', and call', ', and named')}` };
  }
  if (tool === 'register_wallet') {
    const address = String(args.address).toLowerCase();
    const label = str(args.label);
    const role = str(args.role);
    const extra = `${label ? ` as ${quoted(label)}` : ''}${role ? ` (${role})` : ''}`;
    return { tool, args, ask: `Track wallet ${address} on Base${extra}`, done: `I'm reading ${short(address)} on Base${extra}` };
  }
  const g = (await query<{ counterparty_address: string; direction: 'in' | 'out'; asset: string | null; event_count: number; total_usd: string; first_at: Date; last_at: Date }>(
    `SELECT counterparty_address, direction, asset, event_count, total_usd::text AS total_usd, first_at, last_at
     FROM question_groups WHERE id = $1 AND user_id = $2`,
    [args.group_id, userId],
  )).rows[0];
  const label = labelWords(String(args.label));
  if (!g) return { tool, args, ask: `Label those transfers as ${label}`, done: `Labeled those transfers as ${label}` };
  const n = g.event_count;
  const noun = g.direction === 'out'
    ? `${n === 1 ? 'payment' : 'payments'} to ${short(g.counterparty_address)}`
    : `${n === 1 ? 'transfer' : 'transfers'} from ${short(g.counterparty_address)}`;
  const total = parseFloat(g.total_usd) > 0 ? `, ${usdDisplay(parseFloat(g.total_usd))}${n === 1 ? '' : ' total'}` : '';
  const span = day(g.first_at) === day(g.last_at) ? `on ${day(g.last_at)}` : `${day(g.first_at)} to ${day(g.last_at)}`;
  const what = `${n === 1 ? 'the' : `those ${n}`} ${g.asset ? `${g.asset} ` : ''}${noun} (${span}${total})`;
  return { tool, args, ask: `Label ${what} as ${label}`, done: `Labeled ${what} as ${label}` };
}

// "Label … as revenue?" or, for several, each change numbered before the operator says yes
export function changesQuestion(actions: ChangeAction[]): string {
  if (actions.length === 1) return `${actions[0].ask}?`;
  return [`Make these ${actions.length} changes?`, ...actions.map((a, i) => `${i + 1}. ${a.ask}`), '', 'Reply yes or no.'].join('\n');
}

// One open set of changes at a time: a newer request replaces one the operator left unanswered
export async function createChanges(userId: string, actions: ChangeAction[]): Promise<{ id: string; question: string }> {
  await query(
    `UPDATE label_proposals SET status = 'superseded', decided_at = NOW()
     WHERE user_id = $1 AND kind = 'changes' AND status = 'pending'`,
    [userId],
  );
  const question = changesQuestion(actions);
  const res = await query<{ id: string }>(
    // One clock reading for both, so a change waits exactly CHANGES_TTL
    `INSERT INTO label_proposals (user_id, kind, actions, question, created_at, expires_at)
     SELECT $1, 'changes', $2, $3, t.now, t.now + INTERVAL '${CHANGES_TTL}'
     FROM (SELECT clock_timestamp() AS now) t
     RETURNING id`,
    [userId, JSON.stringify(actions), question],
  );
  return { id: res.rows[0].id, question };
}

type Applied = { done: string; note: string | null };
type Skipped = { ask: string; why: string };

// Applies one change after validating it again, now
async function applyChange(userId: string, a: ChangeAction): Promise<Applied | Skipped> {
  if (a.tool === 'label_question_group') {
    const ok = await prepareWriteAction(userId, a.tool, a.args);
    if (!ok.ok) return { ask: a.ask, why: 'those transfers were already labeled' };
    const r = await labelQuestionGroup(String(a.args.group_id), userId, a.args.label as ClassificationLabel);
    if (!r.ok) return { ask: a.ask, why: 'those transfers were already labeled' };
    return { done: a.done, note: describeRuleOutcome(r.rule) };
  }
  const prepared = await prepareWriteAction(userId, a.tool, a.args);
  if (!prepared.ok) {
    return { ask: a.ask, why: a.tool === 'apply_correction' ? 'I could not find that transaction in your books any more' : prepared.error };
  }
  const result = await executeTool(userId, a.tool, prepared.args) as { error?: unknown; note?: unknown } | null;
  if (result && typeof result.error === 'string') return { ask: a.ask, why: result.error };
  return { done: a.done, note: typeof result?.note === 'string' ? result.note : null };
}

export async function answerChanges(p: { userId: string; proposalId: string; accept: boolean }): Promise<ProposalAnswer> {
  const claimed = await query<{ id: string; actions: ChangeAction[] }>(
    `UPDATE label_proposals SET status = $3, decided_at = NOW()
     WHERE id = $1 AND user_id = $2 AND kind = 'changes' AND status = 'pending' AND expires_at > NOW()
     RETURNING id, actions`,
    [p.proposalId, p.userId, p.accept ? 'accepted' : 'declined'],
  );
  const prop = claimed.rows[0];
  if (!prop) return { ok: false, reason: 'not_pending', text: "That request is no longer open, so I haven't changed anything." };
  if (!p.accept) {
    await query(`UPDATE label_proposals SET result = $2 WHERE id = $1`, [prop.id, JSON.stringify({ changed: 0, skipped: 0 })]);
    return { ok: true, accepted: false, changed: 0, skipped: 0, text: "OK, I haven't changed anything." };
  }

  const applied: Applied[] = [];
  const skipped: Skipped[] = [];
  for (const a of prop.actions) {
    try {
      const r = await applyChange(p.userId, a);
      if ('done' in r) applied.push(r); else skipped.push(r);
    } catch (err) {
      logger.error({ err, userId: p.userId, tool: a.tool }, 'Confirmed change failed');
      skipped.push({ ask: a.ask, why: 'something went wrong on my side' });
    }
  }
  await query(`UPDATE label_proposals SET result = $2 WHERE id = $1`, [prop.id, JSON.stringify({ changed: applied.length, skipped: skipped.length })]);

  const notes = applied.map((a) => a.note).filter((n): n is string => !!n);
  let text: string;
  if (prop.actions.length === 1) {
    text = applied.length === 1
      ? `Done. ${applied[0].done}.${notes.length > 0 ? ` ${notes[0]}` : ''}`
      : `I couldn't make that change: ${skipped[0].why}. Nothing was changed.`;
  } else {
    const lines: string[] = [];
    if (applied.length > 0) lines.push(skipped.length > 0 ? `I made ${applied.length} of the ${prop.actions.length} changes:` : 'Done:', ...applied.map((a) => `- ${a.done}`));
    if (skipped.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(applied.length > 0 ? 'Not made:' : `I couldn't make any of the ${prop.actions.length} changes:`, ...skipped.map((s) => `- ${s.ask}: ${s.why}`));
    }
    text = [lines.join('\n'), ...notes].join('\n\n');
  }
  return { ok: true, accepted: true, changed: applied.length, skipped: skipped.length, text };
}

// Answers any of Luca's open questions, whatever kind it is; scoped to its owner
export async function resolveProposal(p: { userId: string; proposalId: string; accept: boolean }): Promise<ProposalAnswer> {
  const kind = (await query<{ kind: string }>(
    `SELECT kind FROM label_proposals WHERE id = $1 AND user_id = $2`, [p.proposalId, p.userId],
  )).rows[0]?.kind;
  return kind === 'changes' ? answerChanges(p) : answerProposal(p);
}
