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

// ---------------------------------------------------------------------------
// Tool input or tool talk never reaches the operator
// ---------------------------------------------------------------------------
// The model sometimes writes a tool call out as text instead of making it: the operator
// asked "show me my recent transactions" and got `{"limit":20,"period_days":7}` followed by
// "I need the tool result to answer that". A reply that shows raw tool input or talks about
// tools is never sent; the model gets one chance to make the call, then Luca says plainly
// that it could not look it up.

const TOOL_TALK = /\btool\s+(results?|calls?|outputs?)\b|\bfunction\s+calls?\b/i;

export function leaksToolCall(text: string): boolean {
  if (TOOL_TALK.test(text)) return true;
  // Any JSON object with at least one field: no answer to an operator contains one
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const v: unknown = JSON.parse(m[0]);
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) return true;
    } catch { /* not JSON */ }
  }
  return false;
}

export const TOOL_LEAK_CORRECTION =
  'Your last reply showed the operator raw tool arguments or talked about tools, instead of calling the tool. Call the tool you meant now, then answer from its result in plain words. Never show JSON or mention tools.';

export const TOOL_LEAK_FALLBACK =
  "Something went wrong on my side while looking that up, so I don't have an answer yet. Ask me again in a moment.";

// ---------------------------------------------------------------------------
// "Recent transactions" means all of them unless the operator names a category
// ---------------------------------------------------------------------------
// The model answered "show me my recent transactions" by asking for unknowns only and
// then said only one transaction happened that week, leaving out a swap. A label filter
// on recent activity is kept only when the operator's own words name that category.

const LABEL_WORDS: Record<string, RegExp> = {
  revenue: /\b(revenue|income|earn(ed|ings?)?|sales?)\b/i,
  expense: /\b(expenses?|spen[dt]|spending|costs?|paid out|outgoing payments?)\b/i,
  internal_transfer: /\b(internal|between (my|our) wallets|own wallets)\b/i,
  treasury: /\btreasury\b/i,
  gas: /\b(gas|network fees?|fees?)\b/i,
  x402_income: /\bx402\b/i,
  x402_spend: /\bx402\b/i,
  refund: /\brefund(s|ed)?\b/i,
  swap: /\b(swaps?|swapped|conver(t|ted|sions?)|trades?)\b/i,
  unknown: /\b(unknowns?|unlabell?ed|unclassified|need(s|ing)? (context|attention|your answer|labels?)|not labell?ed|uncategori[sz]ed)\b/i,
};

export function namesLabel(message: string, label: string): boolean {
  return LABEL_WORDS[label]?.test(message) ?? false;
}

// The arguments recent activity actually runs with: `label` only when the operator named it
export function activityArgs(message: string, args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.label !== 'string' || namesLabel(message, args.label)) return args;
  const { label: _ignored, ...rest } = args;
  void _ignored;
  return rest;
}

// ---------------------------------------------------------------------------
// A change is asked about in Luca's words, not the model's
// ---------------------------------------------------------------------------
// When the model proposes a change, its reply is kept for anything else the operator
// asked, but not when it talks about the change itself: calling it done, or asking for a
// confirmation Luca's own question already asks.

const CHANGE_TALK = new RegExp(
  [
    String.raw`\bdone\b`,
    String.raw`\bi(?:'ve| have)?\s+(?:now\s+)?(?:re)?label(?:l)?ed\b`,
    String.raw`\bi(?:'ve| have)?\s+(?:now\s+)?(?:changed|updated|marked|recorded|added|started tracking|tracked|corrected)\b`,
    String.raw`\b(?:is|are|has been|have been)\s+(?:now\s+)?(?:re)?(?:label(?:l)?ed|tracked|added|updated|marked)\b`,
    String.raw`\b(?:i'?ll|i will|let me|i can|i'?m going to|going to)\s+(?:re)?(?:label|track|add|mark|update|change|record|correct)\b`,
    String.raw`\bconfirm\b`, String.raw`\b(?:shall|should) i\b`, String.raw`\b(?:do you )?want me to\b`,
    String.raw`\btap\b`, String.raw`\bbuttons?\b`,
    // The model asking in Luca's own form, copied from earlier in the chat
    // ("Track wallet 0x… on Base as "Test" (operations)?", Sep 27)
    String.raw`(?:^|[.!?\n]\s*)(?:track wallet|start tracking|label (?:the|those|that|this|it)|make (?:these|this|that)(?: \d+)? changes?)\b`,
  ].join('|'),
  'i',
);

export function restatesChange(text: string): boolean {
  return CHANGE_TALK.test(text);
}

// ---------------------------------------------------------------------------
// Luca never says a change happened unless it did
// ---------------------------------------------------------------------------
// The operator answered "Luca Wallet" (not a yes) to "Track wallet …?", and the model
// replied "Confirmed. I'll track 0xb540…" while nothing was tracked. A reply that says a
// change was made (or will be) is only sent when a change was actually applied in the turn.

const CHANGE_CLAIM = new RegExp(
  [
    // "Confirmed." / "Done." opening a sentence (not "fully confirmed", a label status)
    String.raw`(?:^|[.!?]\s+)(?:confirmed|done)\b`,
    String.raw`\bi(?:'ve| have)\s+(?:now\s+)?(?:re)?label(?:l)?ed\b`,
    String.raw`\bi(?:'ve| have)\s+(?:now\s+)?(?:updated|changed|marked|corrected|started tracking)\b`,
    String.raw`\bi(?:'m| am)\s+now\s+tracking\b`,
    String.raw`\bstarted tracking\b`,
    String.raw`\b(?:is|are)\s+now\s+(?:re)?(?:label(?:l)?ed|tracked|marked)\b`,
  ].join('|'),
  'im',
);

export function claimsChange(text: string): boolean {
  return CHANGE_CLAIM.test(text);
}

export const NO_CHANGE_MADE = "I haven't changed anything.";

// A wallet role only when the operator named one ("track my treasury wallet 0x…")
const ROLE_WORDS: Record<string, RegExp> = {
  operations: /\b(operations?|ops|operating)\b/i,
  treasury: /\btreasury\b/i,
  revenue: /\b(revenue|income)\b/i,
  expenses: /\b(expenses?|spending)\b/i,
  agent: /\bagents?\b/i,
  personal: /\bpersonal\b/i,
};

export function walletArgs(message: string, args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.role !== 'string' || ROLE_WORDS[args.role]?.test(message)) return args;
  const { role: _ignored, ...rest } = args;
  void _ignored;
  return rest;
}

// ---------------------------------------------------------------------------
// Creator fees: the machine report only when the operator asks for it
// ---------------------------------------------------------------------------

const MACHINE_REPORT = /\b(machine|json|raw data|structured)\b/i;

export function feeArgs(message: string, args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.format;
  return MACHINE_REPORT.test(message) ? { ...rest, format: 'machine' } : rest;
}
