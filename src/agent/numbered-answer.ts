import { query } from '../db.js';
import { prepareWriteAction } from './tools.js';
import { createChanges, describeChange, type ChangeAction } from './changes.js';
import { parseNumberedAnswer, latestNumberedList } from './numbered.js';

// An answer by number to Luca's latest numbered list, turned into Luca's own one yes/no
// question (src/agent/changes.ts). Null when the message is not such an answer, so the
// model reads it as usual.
export async function answerNumberedList(userId: string, message: string): Promise<{ text: string; args: Record<string, unknown> } | null> {
  const answer = parseNumberedAnswer(message);
  if (!answer) return null;
  const list = await latestNumberedList(userId);
  if (!list) return null;

  const size = list.kind === 'transfers' ? list.hashes : list.groups;
  const missing = [...answer.labels.keys(), ...answer.unsure].filter((n) => !size.has(n));
  if (missing.length > 0) {
    return {
      text: `My last list has no ${missing.length === 1 ? `number ${missing[0]}` : `numbers ${missing.join(', ')}`}, so I haven't changed anything. Ask "what still needs context?" for a fresh list.`,
      args: { missing },
    };
  }

  const drafts: Array<{ at: number; action: ChangeAction }> = [];
  for (const [n, label] of answer.labels) {
    if (list.kind === 'transfers') {
      // The transfer on that line: the one in this transaction still waiting for a label
      // (a swap's other leg shares the hash)
      const waiting = (await query<{ id: string }>(
        `SELECT ne.id FROM normalized_events ne
         JOIN classifications c ON c.event_id = ne.id AND c.superseded_at IS NULL
         WHERE ne.user_id = $1 AND LOWER(ne.hash) = $2 AND c.label = 'unknown' AND ne.supported IS TRUE`,
        [userId, list.hashes.get(n)],
      )).rows;
      const prepared = await prepareWriteAction(userId, 'apply_correction', { event_id: waiting.length === 1 ? waiting[0].id : list.hashes.get(n), new_label: label });
      if (!prepared.ok) return { text: `I couldn't find number ${n} in your books any more, so I haven't changed anything. Ask "what still needs context?" for a fresh list.`, args: { n } };
      drafts.push({ at: n, action: await describeChange(userId, 'apply_correction', prepared.args) });
    } else {
      const args = { group_id: list.groups.get(n), label };
      const prepared = await prepareWriteAction(userId, 'label_question_group', args);
      if (!prepared.ok) return { text: `Number ${n} was already answered, so I haven't changed anything.`, args: { n } };
      drafts.push({ at: n, action: await describeChange(userId, 'label_question_group', prepared.args) });
    }
  }
  // In the list's own order, so the question reads like the list the operator answered
  drafts.sort((a, b) => a.at - b.at);
  const { question } = await createChanges(userId, drafts.map((d) => d.action), message);
  const left = answer.unsure.length > 0
    ? `I'll leave ${answer.unsure.join(' and ')} as ${answer.unsure.length === 1 ? 'it is' : 'they are'} for now.\n\n`
    : '';
  return { text: `${left}${question}`, args: { labels: Object.fromEntries(answer.labels), unsure: answer.unsure } };
}
