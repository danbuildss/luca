import { query } from '../db.js';
import { txLink } from '../ledger/links.js';
import { escapeLegacyMarkdown } from '../telegram/format.js';
import { amountText } from './amounts.js';
import { namesFor } from './names.js';
import type { ReviewEvent } from '../corrections/store.js';

// "What still needs context?" in Luca's own fixed wording (Oct 5): numbered, so the
// operator can answer "1 was a swap, 2 was revenue"; the house amount format with dollars;
// names instead of addresses; a tappable link per transfer. The model never rewrites it
// (it dropped the dollars, did not number the list, and guessed which ones mattered).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayIn(timezone: string): (d: Date) => string {
  return (d: Date) => {
    try {
      const p = new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric', timeZone: timezone }).formatToParts(d);
      return `${MONTHS[Number(p.find((x) => x.type === 'month')?.value) - 1]} ${p.find((x) => x.type === 'day')?.value}`;
    } catch {
      return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    }
  };
}

export async function unknownListText(userId: string, events: ReviewEvent[], total: number): Promise<string> {
  if (events.length === 0) return 'Nothing needs context right now. Every transfer in your books is labeled.';
  const tz = (await query<{ timezone: string | null }>(`SELECT timezone FROM users WHERE id = $1`, [userId])).rows[0]?.timezone ?? 'UTC';
  const [name, day] = [await namesFor(userId), dayIn(tz)];
  const one = total === 1;
  const lines = [`${total} ${one ? 'transfer still needs' : 'transfers still need'} context:`];
  events.forEach((e, i) => {
    const amount = e.amount === null ? (e.asset ?? 'tokens') : amountText(Math.abs(Number(e.amount)), e.asset, e.usd_value === null ? null : Math.abs(Number(e.usd_value)));
    const who = escapeLegacyMarkdown(name(e.direction === 'in' ? e.from_address : e.to_address, e.direction));
    lines.push(`${i + 1}. ${day(new Date(e.block_time))}: ${amount} ${e.direction === 'in' ? 'from' : 'to'} ${who} ${txLink(e.hash)}`);
  });
  if (total > events.length) lines.push(`…and ${total - events.length} more.`);
  lines.push('', one ? 'Tell me what it was.' : 'Tell me what they were, like "1 was a swap, 2 was revenue".');
  return lines.join('\n');
}
