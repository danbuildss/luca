// Guards for books checks in chat, decided from the operator's own words rather than left
// to the model:
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
