import { txLink } from '../ledger/links.js';
import { escapeLegacyMarkdown } from '../telegram/format.js';
import { amountText, usdText } from '../books/amounts.js';
import type { Namer } from '../books/names.js';
import type { QuestionToSend } from './questions.js';

// How Luca asks about transfers it could not place (Oct 4, PR 2): once, in the morning
// message, as one numbered list, biggest first; or inside the alert for a large one. Never
// a stream of separate "What was it for?" messages.

export type Ask = QuestionToSend;

// "106.88 USDC you sent to 0x1231…4eae, Sep 30 [0xab12…cdef](…)"
export function askItem(q: Ask, name: Namer, day: (d: Date) => string): string {
  const who = escapeLegacyMarkdown(name(q.counterparty_address, q.direction));
  const asset = (q.asset ?? 'ETH').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 20);
  if (q.event_count === 1 && q.amount !== null) {
    const total = parseFloat(q.total_usd);
    const amount = amountText(parseFloat(q.amount), asset, total > 0 ? total : null);
    const what = q.direction === 'in' ? `${amount} you received from ${who}` : `${amount} you sent to ${who}`;
    return `${what}, ${day(q.last_at)}${q.hash ? ` ${txLink(q.hash)}` : ''}`;
  }
  const total = parseFloat(q.total_usd);
  const kind = q.direction === 'in' ? `${asset} transfers from` : `${asset} payments to`;
  const span = day(q.first_at) === day(q.last_at) ? day(q.last_at) : `${day(q.first_at)} to ${day(q.last_at)}`;
  return `${q.event_count} ${kind} ${who}${total > 0 ? ` (${usdText(total)} total)` : ''}, ${span}`;
}

export function askText(asks: Ask[], name: Namer, day: (d: Date) => string): string {
  if (asks.length === 1) return ['One thing I couldn\'t place:', askItem(asks[0], name, day), 'What was it for?'].join('\n');
  return [
    `${asks.length} things I couldn't place:`,
    ...asks.map((q, i) => `${i + 1}. ${askItem(q, name, day)}`),
    'Tell me what they were, like "1 was a swap, 2 was revenue".',
  ].join('\n');
}
