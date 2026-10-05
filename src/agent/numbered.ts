import { query } from '../db.js';
import type { ClassificationLabel } from '../types/index.js';

// "1 was an expense, 2 was an internal transfer, 4 and 7 were swaps, not sure about 8":
// an answer to the numbered list Luca just sent, read in code (Oct 5). Each number is the
// transfer at that place in Luca's own message, never re-derived from the books, so a
// transfer that arrived since cannot shift the numbers. The model, given this answer,
// asked for confirmation itself and changed nothing.

const WORDS: Array<[RegExp, ClassificationLabel]> = [
  [/^(?:an?\s+)?(?:internal(?:\s+transfers?)?|transfers?\s+between\s+(?:my|our)\s+(?:own\s+)?wallets|my\s+own\s+(?:money|funds|wallets?)|own\s+transfers?)$/, 'internal_transfer'],
  [/^(?:an?\s+)?(?:expenses?|payments?\s+for\s+\w+|costs?|spend(?:ing)?)$/, 'expense'],
  [/^(?:an?\s+)?(?:revenue|income|sales?|payments?\s+(?:to|from)\s+(?:a\s+)?customers?)$/, 'revenue'],
  [/^(?:an?\s+)?(?:swaps?|trades?|token\s+swaps?)$/, 'swap'],
  [/^(?:an?\s+)?refunds?$/, 'refund'],
  [/^(?:an?\s+)?(?:stake|staked|staking)$/, 'staked'],
  [/^(?:an?\s+)?(?:unstake|unstaked|unstaking)$/, 'unstaked'],
  [/^(?:an?\s+)?staking\s+rewards?$/, 'staking_reward'],
  [/^(?:an?\s+)?(?:gas|network\s+fees?)$/, 'gas'],
];

export type NumberedAnswer = { labels: Map<number, ClassificationLabel>; unsure: number[] };

const NUMS = String.raw`\d{1,2}(?:\s*(?:,|and|&)\s*\d{1,2})*`;
const nums = (s: string): number[] => (s.match(/\d{1,2}/g) ?? []).map(Number);

const SEP = String.raw`(?=\s*(?:[,;.!\n]|$|\s+and\s+(?:\d|not|i\s|no\s)|\s+but\s))`;
const CLAUSE = new RegExp(String.raw`#?(${NUMS})\s+(?:was|were|is|are)\s+([a-z][a-z' ]*?)(?:\s+too)?` + SEP, 'g');
const DOUBT = new RegExp(String.raw`(?:(?:i'?m\s+)?not\s+sure\s+(?:about|of)|no\s+idea\s+(?:about|on)|(?:i\s+)?don'?t\s+know\s+(?:about\s+)?|unsure\s+(?:about|of)|skip|leave)\s+#?(${NUMS})(?:\s+(?:for\s+now|as\s+it\s+is))?` + SEP, 'g');

// Null unless the whole message is a numbered answer Luca understands
export function parseNumberedAnswer(message: string): NumberedAnswer | null {
  const text = message.toLowerCase().trim();
  const labels = new Map<number, ClassificationLabel>();
  const unsure: number[] = [];
  let rest = text;
  for (const m of text.matchAll(CLAUSE)) {
    const label = WORDS.find(([re]) => re.test(m[2].trim()))?.[1];
    if (!label) return null;
    for (const n of nums(m[1])) labels.set(n, label);
    rest = rest.replace(m[0], ' ');
  }
  for (const m of text.matchAll(DOUBT)) {
    unsure.push(...nums(m[1]));
    rest = rest.replace(m[0], ' ');
  }
  // Anything left must only be separators: otherwise the model reads it
  if (!/^[\s,;.!&]*(?:(?:and|but|ok|okay|so)[\s,;.!&]*)*$/.test(rest)) return null;
  return labels.size > 0 ? { labels, unsure } : null;
}

export type NumberedList =
  | { kind: 'transfers'; hashes: Map<number, string> }
  | { kind: 'groups'; groups: Map<number, string> };

const TX_IN_LINE = /^(\d{1,2})\.\s.*\(https:\/\/basescan\.org\/tx\/(0x[0-9a-fA-F]{64})\)/;

// The numbered list in Luca's latest message, if that is what the operator is answering:
// "N transfers still need context:" (each line links its transaction) or the morning
// message's "N things I couldn't place:" (its items are numbered in question_groups)
export async function latestNumberedList(userId: string): Promise<NumberedList | null> {
  const last = (await query<{ content: string; created_at: Date }>(
    `SELECT content, created_at FROM conversation_messages
     WHERE user_id = $1 AND role = 'assistant' AND created_at > NOW() - INTERVAL '2 days'
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  )).rows[0];
  if (!last) return null;
  if (/still needs? context:/.test(last.content)) {
    const hashes = new Map<number, string>();
    for (const line of last.content.split('\n')) {
      const m = TX_IN_LINE.exec(line);
      if (m) hashes.set(Number(m[1]), m[2].toLowerCase());
    }
    return hashes.size > 0 ? { kind: 'transfers', hashes } : null;
  }
  if (/things I couldn't place:/.test(last.content)) {
    const rows = (await query<{ id: string; asked_item: number }>(
      `SELECT id, asked_item FROM question_groups
       WHERE user_id = $1 AND status = 'open' AND asked_item IS NOT NULL
         AND telegram_message_id = (
           SELECT telegram_message_id FROM question_groups
           WHERE user_id = $1 AND asked_item IS NOT NULL AND telegram_message_id IS NOT NULL
           ORDER BY sent_at DESC LIMIT 1)`,
      [userId],
    )).rows;
    return rows.length > 0 ? { kind: 'groups', groups: new Map(rows.map((r) => [r.asked_item, r.id])) } : null;
  }
  return null;
}
