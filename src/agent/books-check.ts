import { query } from '../db.js';
import { requestAudit, type AuditRequest } from '../ledger/audit-runs.js';
import { asksCompleteness, periodDays } from './checks.js';

// "Are my books complete?" is answered here, not by the model: the question starts a check
// (or reuses a still-valid result) and the reply is fixed wording from the check itself.
// An admin can ask about another operator by @username ("check @alice's books").

export type BooksCheckReply = { text: string; args: Record<string, unknown> };

async function isAdmin(userId: string): Promise<boolean> {
  const r = await query<{ role: string }>(`SELECT role::text AS role FROM users WHERE id = $1`, [userId]);
  return r.rows[0]?.role === 'admin';
}

function walletsText(subject: string, n?: number): string {
  if (n === undefined) return `${subject} wallets`;
  return n === 1 ? `${subject} wallet` : `${subject} ${n} wallets`;
}

function periodText(days: number | null): string {
  if (days === null) return "everything I've tracked across";
  return days === 1 ? 'the last day across' : `the last ${days} days across`;
}

export function replyFor(r: AuditRequest, days: number | null, subject = 'your'): string {
  switch (r.status) {
    case 'no_wallets':
      return subject === 'your'
        ? "You don't have any wallets for me to check yet. Send me a Base wallet address and I'll start tracking it."
        : `${subject.replace(/'s$/, '')} has no wallets for me to check yet.`;
    case 'running':
      return `I'm already checking ${walletsText(subject)}. I'll message you with the result when it's done.`;
    case 'started':
      return `Checking ${periodText(days)} ${walletsText(subject, r.wallets)} against the chain now. I'll message you with the result, usually within a few minutes.`;
    case 'reused':
      return r.message;
  }
}

// Starts (or reuses) a check for the question asked, whatever the model would have said
export async function startBooksCheck(p: { userId: string; message: string }): Promise<BooksCheckReply> {
  const days = periodDays(p.message);
  const handle = /@([A-Za-z0-9_]{3,32})/.exec(p.message)?.[1];
  // Another operator's books: admins only, checked against the database, never the caller's word
  if (handle && await isAdmin(p.userId)) {
    const target = (await query<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(LTRIM(telegram_username, '@')) = LOWER($1)`, [handle],
    )).rows[0];
    if (!target) return { text: `I don't know an operator called @${handle}.`, args: { username: handle, days } };
    if (target.id !== p.userId) {
      const r = await requestAudit({ userId: target.id, requestedBy: p.userId, days, admin: true });
      return { text: replyFor(r, days, `@${handle}'s`), args: { username: handle, days } };
    }
  }
  const r = await requestAudit({ userId: p.userId, requestedBy: p.userId, days });
  return { text: replyFor(r, days), args: { days } };
}

// Null when the message is not a completeness question
export async function answerBooksCheck(p: { userId: string; message: string }): Promise<BooksCheckReply | null> {
  return asksCompleteness(p.message) ? startBooksCheck(p) : null;
}
