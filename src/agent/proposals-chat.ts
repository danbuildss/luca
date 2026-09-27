import { query } from '../db.js';
import { pendingProposals, isCurrent, type OpenQuestion } from '../corrections/proposals.js';
import { resolveProposal } from './changes.js';

// Answers to Luca's yes/no questions (a change the operator asked for: "Label … as
// revenue?", or earlier transfers a rule covers: "want me to label them revenue too?"),
// decided in code, never guessed by the model:
//  - A bare "yes" or "no" answers the question only when it is the one open question and
//    the operator has said nothing else since it was asked.
//  - Otherwise Luca asks which question they mean, numbered; "yes to 2" then answers it.
//  - A longer answer ("yes, update those 6 payments") goes to the model, which can answer
//    a question by its id with the answer_proposal tool; run.ts checks the operator's own
//    words agree with it (see explicitAnswer).

const YES = /^(y|ya|yes|yeah|yep|yup|sure|ok|okay|k|confirm(ed)?|correct|do it|go ahead|go for it|please do|yes please|sounds good|\u{1F44D})$/u;
const NO = /^(n|no|nope|nah|no thanks|don'?t|do not|cancel|leave (it|them)( as (it is|they are))?|skip|not now|\u{1F44E})$/u;

function normalise(message: string): string {
  return message.trim().toLowerCase().replace(/[.!\s]+$/u, '').replace(/\s+/g, ' ');
}

// "yes" / "no" and nothing else
export function bareAnswer(message: string): boolean | null {
  const m = normalise(message);
  if (YES.test(m)) return true;
  if (NO.test(m)) return false;
  return null;
}

// "yes to 2", "yes 2", "no to #1", "2 yes"
export function numberedAnswer(message: string): { n: number; accept: boolean } | null {
  const m = normalise(message);
  const first = /^(yes|no)(?: to)? #?(\d{1,2})$/.exec(m);
  if (first) return { n: Number(first[2]), accept: first[1] === 'yes' };
  const last = /^#?(\d{1,2}):? (yes|no)$/.exec(m);
  if (last) return { n: Number(last[1]), accept: last[2] === 'yes' };
  return null;
}

const AFFIRM = /\b(yes|yeah|yep|sure|ok|okay|go ahead|do it|please do|update|apply|confirm)\b/i;
const DENY = /\b(no|nope|don'?t|do not|leave|cancel|skip|not)\b/i;

// Whether the operator's own words back the answer the model wants to give a question
export function explicitAnswer(message: string, accept: boolean): boolean {
  return accept ? AFFIRM.test(message) && !DENY.test(message) : DENY.test(message);
}

export type ProposalReply = { text: string; args: Record<string, unknown> };

async function timezone(userId: string): Promise<string> {
  return (await query<{ timezone: string | null }>(`SELECT timezone FROM users WHERE id = $1`, [userId])).rows[0]?.timezone ?? 'UTC';
}

// The numbered list Luca shows when it is not sure which question an answer is for
export async function whichOne(userId: string, open: OpenQuestion[]): Promise<string> {
  const tz = await timezone(userId);
  const when = (d: Date): string => {
    try { return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }); }
    catch { return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }); }
  };
  const items = open.map((p, i) => `${i + 1}. (${when(p.created_at)}) ${p.question.split('\n')[0]}`);
  const head = open.length === 1
    ? 'Just to be sure, do you mean this question I asked earlier?'
    : `I have ${open.length} open questions for you. Which one do you mean?`;
  const example = open.length === 1 ? '"yes to 1" or "no to 1"' : '"yes to 1" or "no to 2"';
  return [head, '', ...items, '', `Reply ${example}. Until then I won't change anything.`].join('\n');
}

// Null when the message is not an answer to one of Luca's open questions
export async function answerProposalReply(p: { userId: string; message: string }): Promise<ProposalReply | null> {
  const bare = bareAnswer(p.message);
  const numbered = bare === null ? numberedAnswer(p.message) : null;
  if (bare === null && numbered === null) return null;

  const open = await pendingProposals(p.userId);
  if (open.length === 0) return null;

  if (numbered) {
    const target = open[numbered.n - 1];
    if (!target) return { text: await whichOne(p.userId, open), args: { answered: null } };
    const r = await resolveProposal({ userId: p.userId, proposalId: target.id, accept: numbered.accept });
    return { text: r.text, args: { proposal_id: target.id, accept: numbered.accept } };
  }

  if (open.length === 1 && await isCurrent(p.userId, open[0])) {
    const r = await resolveProposal({ userId: p.userId, proposalId: open[0].id, accept: bare === true });
    return { text: r.text, args: { proposal_id: open[0].id, accept: bare } };
  }
  return { text: await whichOne(p.userId, open), args: { answered: null } };
}
