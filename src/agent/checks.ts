// Guards for books checks in chat, decided from the operator's own words and the check's
// own result rather than left to the model:
//  - A check covers everything tracked unless the operator names a period. The model
//    used to pass `days: 1` for "are my books complete?", silently checking one day.
//  - Luca never says a check is running unless one was started in that turn. The model
//    used to reply "I'm checking…" without calling the tool at all.

export const CHECK_TOOLS = new Set(['check_books_complete', 'admin_check_books']);

// "yesterday", "today", "overnight", "this week", "last 3 days", "past month", "since Monday"…
const PERIOD = new RegExp(
  [
    String.raw`\byesterday\b`, String.raw`\btoday\b`, String.raw`\btonight\b`, String.raw`\bovernight\b`,
    String.raw`\blast night\b`, String.raw`\bthis (morning|week|month)\b`,
    String.raw`\b(last|past|previous)\s+(\d+\s+)?(day|days|week|weeks|month|months|24 ?h(ours)?)\b`,
    String.raw`\b\d+\s*(day|days|week|weeks|month|months)\b`,
    String.raw`\bsince\s+\S+`,
  ].join('|'),
  'i',
);

export function namesPeriod(message: string): boolean {
  return PERIOD.test(message);
}

// The arguments a check actually runs with: `days` only when the operator named a period
export function checkArgs(message: string, args: Record<string, unknown>): Record<string, unknown> {
  if (namesPeriod(message)) return args;
  const { days: _ignored, ...rest } = args;
  void _ignored;
  return rest;
}

// A reply that tells the operator a books check is under way
const CLAIM = /\b(will|i'?ll)\s+message you\b|\bchecking\s+(everything|all|your\s+(wallets?|books))\b|\bi'?m\s+(now\s+)?checking\b/i;

export function claimsCheck(text: string): boolean {
  return CLAIM.test(text);
}

export const CLAIM_CORRECTION =
  'Your last reply said a books check is under way, but no check was started. Start it now by calling the matching tool (check_books_complete for the operator\'s own wallets). Do not reply until you have called it.';

export const NO_CHECK_STARTED =
  "I haven't started a check of your wallets. Ask me \"are my books complete?\" and I'll run one.";

// ---------------------------------------------------------------------------
// Completeness questions are answered without the model
// ---------------------------------------------------------------------------
// "Are my books complete?" has one honest answer: a check's own result. The model used to
// write the verdict itself from earlier messages ("Yes. Your books are complete") without
// checking anything, so these questions go straight to the check and the reply is the
// check's fixed wording.

const COMPLETENESS = new RegExp(
  [
    String.raw`\b(are|is)\s+(my|our|the|all)\s+(my\s+)?books\s+(complete|up\s*to\s*date|current|right|correct|accurate|ok|okay|in order)\b`,
    String.raw`\bbooks\s+(are\s+)?complete\b`,
    String.raw`\b(missing|miss(ed)?)\s+anything\b`,
    String.raw`\b(catch|caught)\s+everything\b`,
    String.raw`\bcheck\s+(everything|all\s+my\s+wallets|my\s+wallets?|our\s+wallets?|my\s+books|our\s+books)\b`,
    String.raw`\bcheck\s+@\w+('s)?\s+(books|wallets?)\b`,
  ].join('|'),
  'i',
);

export function asksCompleteness(message: string): boolean {
  return COMPLETENESS.test(message);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// The number of days a named period covers; null when the message names none (everything)
export function periodDays(message: string, now = new Date()): number | null {
  const m = message.toLowerCase();
  if (/\b(yesterday|today|tonight|overnight|last night|this morning|24 ?h(ours)?)\b/.test(m)) return 1;
  const n = /\b(?:last|past|previous)?\s*(\d+)\s*(day|days|week|weeks|month|months)\b/.exec(m);
  if (n) return Number(n[1]) * (n[2].startsWith('week') ? 7 : n[2].startsWith('month') ? 30 : 1);
  if (/\b(this|last|past|previous)\s+week\b/.test(m)) return 7;
  if (/\b(this|last|past|previous)\s+month\b/.test(m)) return 30;
  const since = /\bsince\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(m);
  if (since) {
    const back = (now.getUTCDay() - WEEKDAYS.indexOf(since[1]) + 7) % 7;
    return Math.max(1, back);
  }
  return null;
}

// A reply that states a completeness verdict
const VERDICT = /\bbooks\s+are\s+(complete|up\s*to\s*date|current|in order)\b|\bno\s+missing\s+(movements?|transactions?)\b|\bnothing\s+(is\s+)?missing\b|\bevery\s+supported\s+movement\b|\bnot\s+missing\s+anything\b/i;

export function claimsVerdict(text: string): boolean {
  return VERDICT.test(text);
}

export const VERDICT_CORRECTION =
  'Your last reply said whether the books are complete or that nothing is missing, but no check ran in this turn. Only a books check can say that. Answer the question without any completeness verdict.';
