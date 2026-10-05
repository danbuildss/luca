// Integration: decision history (migration 030, data compounds). What Luca decided and
// why, what the operator changed and in their words, the rule it taught and that rule's
// history, every question asked and answered, and prices replaced by better ones are all
// kept; nothing is overwritten.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassifiedEvent, insertCounterpartyRule,
  insertCorrection, sql, addr,
} from './helpers/db.js';
import { saveManyClassifications } from '../../src/classification/store.js';
import { applyCorrection } from '../../src/corrections/handler.js';
import { createChanges, describeChange, answerChanges } from '../../src/agent/changes.js';
import { refreshQuestionGroups, getQuestionsToSend, markQuestionSent, markAskedByAlert, skipQuestionGroup, labelQuestionGroup } from '../../src/alerts/questions.js';
import { priceSwaps } from '../../src/ingestion/reprice.js';

const active = (eventId: string) => sql<{ id: string; label: string; model: string | null; prompt_version: string | null; inputs: unknown; rule_id: string | null }>(
  `SELECT id, label::text, model, prompt_version, inputs, rule_id FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`, [eventId]);
const ruleEvents = (ruleId: string) => sql<{ event: string; before: Record<string, unknown> | null; after: Record<string, unknown>; correction_id: string | null; reason: string | null }>(
  `SELECT event, before, after, correction_id, reason FROM rule_events WHERE rule_id = $1 ORDER BY created_at`, [ruleId]);
const questionEvents = (groupId: string) => sql<{ event: string; channel: string | null; item: number | null; label: string | null; total_usd: string }>(
  `SELECT event, channel, item, label, total_usd::text FROM question_events WHERE group_id = $1 ORDER BY created_at`, [groupId]);

describeDb('decision history (integration)', () => {
  useIntegrationDb();

  it('an AI label keeps its model, instructions fingerprint and inputs; a rule label keeps its rule, with no AI fields', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const ai = await insertEvent({ wallet, direction: 'out', amount: 50, usdValue: 50 });
    const byRule = await insertEvent({ wallet, direction: 'out', amount: 9, usdValue: 9 });
    const rule = await insertCounterpartyRule({ userId: user.id, address: addr(), label: 'expense', direction: 'out' });

    await saveManyClassifications([
      { event_id: ai.id, user_id: user.id, label: 'expense', confidence: 0.72, method: 'model', evidence: 'Looks like a vendor payment.',
        model: 'gpt-5.4-mini', prompt_version: 'a1b2c3d4e5f6', inputs: { direction: 'out', amount: 50, counterparty_history: { count: 3 } } },
      { event_id: byRule.id, user_id: user.id, label: 'expense', confidence: 1, method: 'counterparty', evidence: 'Rule', rule_id: rule },
    ]);

    expect((await active(ai.id))[0]).toMatchObject({ model: 'gpt-5.4-mini', prompt_version: 'a1b2c3d4e5f6', inputs: { direction: 'out', amount: 50, counterparty_history: { count: 3 } }, rule_id: null });
    expect((await active(byRule.id))[0]).toMatchObject({ model: null, prompt_version: null, inputs: null, rule_id: rule });
  });

  it('a confirmed correction keeps the operator\'s words, what it replaced, what it created and the rule it taught', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const stake = await insertClassifiedEvent({ wallet, direction: 'out', asset: 'BNKR', amount: 700000, usdValue: 297.15, label: 'unknown', confidence: 0.14, method: 'model' });
    const before = (await active(stake.id))[0];

    const action = await describeChange(user.id, 'apply_correction', { event_id: stake.id, new_label: 'staked' });
    const { id } = await createChanges(user.id, [action], 'Its BNKR staking, not an expense');
    expect((await answerChanges({ userId: user.id, proposalId: id, accept: true })).ok).toBe(true);

    const after = (await active(stake.id))[0];
    const [c] = await sql<{ source_message: string; classification_id: string; old_label: string; old_confidence: string; new_classification_id: string; rule_id: string; created_rule: boolean }>(
      `SELECT source_message, classification_id, old_label::text, old_confidence::text, new_classification_id, rule_id, created_rule FROM corrections WHERE event_id = $1`, [stake.id]);
    expect(c).toMatchObject({ source_message: 'Its BNKR staking, not an expense', classification_id: before.id, old_label: 'unknown', new_classification_id: after.id, created_rule: true });
    expect(Number(c.old_confidence)).toBe(0.14);
    expect(c.rule_id).toEqual(expect.any(String));
    // What Luca first thought is still there, superseded, not gone
    expect(await sql(`SELECT 1 FROM classifications WHERE id = $1 AND superseded_at IS NOT NULL`, [before.id])).toHaveLength(1);
    expect((await ruleEvents(c.rule_id))[0]).toMatchObject({ event: 'created', before: null, after: { label: 'staked', active: true } });
  });

  it('a rule\'s history: taught revenue, switched off by a contradiction (reason kept), back on as expense', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const cp = addr();
    const first = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: cp, amount: 10, usdValue: 10, label: 'unknown' });
    const second = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: cp, amount: 11, usdValue: 11, label: 'revenue' });
    const third = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: cp, amount: 12, usdValue: 12, label: 'unknown' });

    const taught = await applyCorrection({ userId: user.id, eventId: first.id, newLabel: 'revenue' });
    const contradicted = await applyCorrection({ userId: user.id, eventId: second.id, newLabel: 'internal_transfer' });
    expect(contradicted.rule.kind).toBe('switched_off');
    const again = await applyCorrection({ userId: user.id, eventId: third.id, newLabel: 'expense' });

    const [{ id: ruleId }] = await sql<{ id: string }>(`SELECT id FROM counterparty_rules WHERE user_id = $1`, [user.id]);
    const history = await ruleEvents(ruleId);
    expect(history.map((h) => h.event)).toEqual(['created', 'disabled', 'reenabled']);
    expect(history[0]).toMatchObject({ after: { label: 'revenue', active: true }, correction_id: taught.correctionId });
    expect(history[1]).toMatchObject({
      before: { label: 'revenue', active: true }, after: { active: false, disabled_reason: 'Contradicted by a correction to internal_transfer' },
      correction_id: contradicted.correctionId, reason: 'Contradicted by a correction to internal_transfer',
    });
    expect(history[2]).toMatchObject({ before: { label: 'revenue', active: false }, after: { label: 'expense', active: true, disabled_reason: null }, correction_id: again.correctionId });
  });

  it('every question asked and what came of it: morning then answered; alert then skipped; closed when answered elsewhere', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const a = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 106.88, usdValue: 106.88, label: 'unknown' });
    const b = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), amount: 49.79, usdValue: 49.79, label: 'unknown' });
    const c = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), amount: 56.65, usdValue: 56.65, label: 'unknown' });
    await refreshQuestionGroups(user.id);
    const groups = await getQuestionsToSend(user.id);
    const g = (eventTo: string) => groups.find((q) => q.counterparty_address === eventTo)!;
    const ga = g(a.to!);
    const gb = g(b.from);
    const gc = g(c.from);

    await markQuestionSent(ga.id, 71, 1);
    await labelQuestionGroup(ga.id, user.id, 'swap', '1 was a swap');
    expect(await questionEvents(ga.id)).toEqual([
      { event: 'asked', channel: 'morning', item: 1, label: null, total_usd: '106.88' },
      { event: 'answered', channel: null, item: null, label: 'swap', total_usd: '106.88' },
    ]);
    expect((await sql<{ source_message: string }>(`SELECT source_message FROM corrections WHERE event_id = $1`, [a.id]))[0].source_message).toBe('1 was a swap');

    await markAskedByAlert(user.id, b.from, 'in');
    await skipQuestionGroup(gb.id, user.id);
    expect((await questionEvents(gb.id)).map((e) => [e.event, e.channel])).toEqual([['asked', 'alert'], ['skipped', null]]);

    await applyCorrection({ userId: user.id, eventId: c.id, newLabel: 'revenue' });
    await refreshQuestionGroups(user.id);
    expect((await questionEvents(gc.id)).map((e) => e.event)).toEqual(['closed']);
  });

  it('a price replaced by a better one is kept; a first price adds nothing', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const swap = `0x${'5a'.repeat(32)}`;
    const bought = await insertClassifiedEvent({ wallet, direction: 'in', asset: 'BNKR', amount: 700000, usdValue: 297.15, label: 'swap', hash: swap, sourceKey: 'log:1', logIndex: 1 });
    await insertClassifiedEvent({ wallet, direction: 'out', asset: 'USDC', amount: 301.02, usdValue: 301.02, label: 'swap', hash: swap, sourceKey: 'log:2', logIndex: 2 });
    await sql(`UPDATE normalized_events SET price_source = 'coingecko' WHERE id = $1`, [bought.id]);
    const swap2 = `0x${'5b'.repeat(32)}`;
    const unpriced = await insertClassifiedEvent({ wallet, direction: 'in', asset: 'BNKR', amount: 1000, usdValue: null, label: 'swap', hash: swap2, sourceKey: 'log:1', logIndex: 1 });
    await insertClassifiedEvent({ wallet, direction: 'out', asset: 'USDC', amount: 0.43, usdValue: 0.43, label: 'swap', hash: swap2, sourceKey: 'log:2', logIndex: 2 });
    await sql(`UPDATE classifications SET shape = 'swap' WHERE user_id = $1`, [user.id]);

    expect(await priceSwaps()).toBe(2);
    const revisions = await sql<{ event_id: string; old_usd_value: string; old_price_source: string; new_usd_value: string; new_price_source: string }>(
      `SELECT event_id, old_usd_value::text, old_price_source, new_usd_value::text, new_price_source FROM price_revisions`);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ event_id: bought.id, old_usd_value: '297.15', old_price_source: 'coingecko', new_price_source: 'swap' });
    expect(Number(revisions[0].new_usd_value)).toBeCloseTo(301.02, 2);
    expect(await sql(`SELECT 1 FROM price_revisions WHERE event_id = $1`, [unpriced.id])).toEqual([]);
  });

  it('migration 031 links an older correction to the rule for its address and direction, and nothing else', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const cp = addr();
    const inRule = await insertCounterpartyRule({ userId: user.id, address: cp, label: 'revenue', direction: 'in' });
    await insertCounterpartyRule({ userId: user.id, address: cp, label: 'expense', direction: 'out' });
    const ev = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: cp, amount: 5, usdValue: 5, label: 'revenue' });
    const taught = await insertCorrection({ userId: user.id, eventId: ev.id, counterpartyAddress: cp, newLabel: 'revenue', createdRule: true });
    const noRule = await insertCorrection({ userId: user.id, eventId: ev.id, counterpartyAddress: cp, newLabel: 'revenue', createdRule: false });

    const migration = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations/031_correction_rule_links.sql'), 'utf8');
    await sql(migration);

    const links = await sql<{ id: string; rule_id: string | null }>(`SELECT id, rule_id FROM corrections WHERE user_id = $1`, [user.id]);
    expect(links.find((l) => l.id === taught)?.rule_id).toBe(inRule);
    expect(links.find((l) => l.id === noRule)?.rule_id).toBeNull();
  });

  it('migration 030 backfills: every existing rule gets a starting snapshot, and known correction→rule links are filled', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const cp = addr();
    const rule = await insertCounterpartyRule({ userId: user.id, address: cp, label: 'revenue', name: 'Acme', direction: 'in' });
    const ev = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: cp, amount: 5, usdValue: 5, label: 'revenue' });
    const correction = await insertCorrection({ userId: user.id, eventId: ev.id, counterpartyAddress: cp, newLabel: 'revenue', createdRule: true });
    await sql(
      `INSERT INTO label_proposals (user_id, kind, rule_id, correction_id, source_event_id, counterparty_address, direction, label, event_ids, question)
       VALUES ($1, 'apply_rule', $2, $3, $4, $5, 'in', 'revenue', $6, 'Label them revenue too?')`,
      [user.id, rule, correction, ev.id, cp, [ev.id]],
    );

    const migration = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations/030_decision_history.sql'), 'utf8');
    await sql(migration);
    await sql(migration); // safe to replay

    expect(await ruleEvents(rule)).toEqual([expect.objectContaining({ event: 'existing', before: null, after: expect.objectContaining({ label: 'revenue', name: 'Acme', active: true }) as unknown })]);
    expect((await sql<{ rule_id: string }>(`SELECT rule_id FROM corrections WHERE id = $1`, [correction]))[0].rule_id).toBe(rule);
  });
});
