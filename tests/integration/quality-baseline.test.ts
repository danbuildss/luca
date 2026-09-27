// Integration: the canonical classification-quality baseline (src/quality/baseline.ts).
// Operator decisions are the evidence; "not corrected" is never "correct"; the high-
// confidence denominator is reviewed high-confidence predictions only; the gold set is
// separate; two clocks (when a transfer happened vs when the operator decided); repeated
// mistakes only where the learned rule applied; all operators summed from raw counts.
import { it, expect, vi, describe } from 'vitest';

vi.mock('../../src/ingestion/price.js', () => ({
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
  enrichUsdValue: vi.fn(),
}));

import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertUser, insertEvent, insertClassification, insertClassifiedEvent,
  insertCounterpartyRule, sql, addr, type WalletFx, type Label, type At,
} from './helpers/db.js';
import { getQualityBaseline, describeQuality, describeQualityShort } from '../../src/quality/baseline.js';
import { executeAdminTool } from '../../src/agent/admin-tools.js';
import { executeTool } from '../../src/agent/tools.js';

// Luca labels a transfer, then the operator decides. Returns the event.
async function decided(wallet: WalletFx, o: {
  luca?: Label | 'none' | 'failure'; confidence?: number; method?: 'model' | 'counterparty' | 'deterministic';
  answer: Label; lucaAt?: At; answerAt?: At; happenedAt?: At; counterparty?: string; direction?: 'in' | 'out';
  ruleId?: string; priorByOperator?: boolean;
}) {
  const ev = await insertEvent({ wallet, direction: o.direction ?? 'in', counterparty: o.counterparty, amount: 10, usdValue: 10, at: o.happenedAt ?? '2 hours' });
  if (o.luca !== 'none') {
    const id = await insertClassification({
      eventId: ev.id, userId: wallet.userId, label: o.luca === 'failure' ? 'unknown' : o.luca ?? 'revenue',
      confidence: o.confidence ?? 0.95, method: o.method ?? 'model', superseded: true, createdAt: o.lucaAt ?? '90 minutes',
      source: o.luca === 'failure' ? 'failure' : o.priorByOperator ? 'user' : null,
    });
    if (o.ruleId) await sql(`UPDATE classifications SET rule_id = $2, method = 'counterparty' WHERE id = $1`, [id, o.ruleId]);
  }
  await insertClassification({ eventId: ev.id, userId: wallet.userId, label: o.answer, confidence: 1, method: 'counterparty', source: 'user', createdAt: o.answerAt ?? '1 hour' });
  return ev;
}
const all = (days = 7) => getQualityBaseline({ userId: null, days });

describeDb('classification-quality baseline (integration)', () => {
  useIntegrationDb();

  it('sorts operator decisions: confirmed, corrected, unknown answered; the operator changing their own mind is not counted', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await decided(wallet, { luca: 'revenue', answer: 'revenue' });
    await decided(wallet, { luca: 'revenue', answer: 'expense' });
    await decided(wallet, { luca: 'unknown', answer: 'expense' });
    await decided(wallet, { luca: 'failure', answer: 'expense' });
    await decided(wallet, { luca: 'none', answer: 'refund' });
    await decided(wallet, { luca: 'expense', answer: 'refund', priorByOperator: true });

    const q = await getQualityBaseline({ userId: user.id, days: 7 });
    // The operator's own first label (on a transfer Luca had not labeled) is itself an answered unknown
    expect(q.decisions).toMatchObject({ reviewed: 2, confirmed: 1, corrected: 1, unknown_answered: 4, operator_revisions: 1 });
    // Two reviewed labels is not enough to state a rate
    expect(q.decisions.correction_rate).toEqual({ num: 1, den: 2, rate: null });
  });

  it('high-confidence wrong is divided by reviewed high-confidence predictions only, and warns only on 5 or more of them', async () => {
    const { user, wallet } = await seedUserWithWallet();
    // 4 high-confidence reviewed (0.90 counts), 1 wrong; plenty of low-confidence ones
    await decided(wallet, { luca: 'revenue', confidence: 0.9, answer: 'expense' });
    for (let i = 0; i < 3; i++) await decided(wallet, { luca: 'revenue', confidence: 0.95, answer: 'revenue' });
    for (let i = 0; i < 6; i++) await decided(wallet, { luca: 'expense', confidence: 0.89, answer: 'expense' });

    let q = await getQualityBaseline({ userId: user.id, days: 7 });
    expect(q.decisions.high_confidence).toMatchObject({ num: 1, den: 4, rate: null });
    expect(q.warnings.some((w) => w.startsWith('High-confidence wrong'))).toBe(false);

    await decided(wallet, { luca: 'revenue', confidence: 0.99, answer: 'revenue' });
    q = await getQualityBaseline({ userId: user.id, days: 7 });
    expect(q.decisions.high_confidence).toMatchObject({ num: 1, den: 5, rate: 0.2 });
    expect(q.decisions.high_confidence.mistakes).toEqual([expect.objectContaining({ luca: 'revenue', operator: 'expense', confidence: 0.9 })]);
    expect(q.warnings).toContain('High-confidence wrong is 20% (1 of 5 reviewed high-confidence predictions), above 5.0%.');
  });

  it('reviewed precision per label, warning only with 5 reviewed for that label; internal-transfer mistakes both ways', async () => {
    const { user, wallet } = await seedUserWithWallet();
    // Below the high-confidence threshold, so only the precision warning is in play
    for (const answer of ['revenue', 'revenue', 'revenue', 'internal_transfer', 'refund'] as const) await decided(wallet, { luca: 'revenue', confidence: 0.7, answer });
    for (const answer of ['expense', 'expense', 'expense', 'swap'] as const) await decided(wallet, { luca: 'expense', confidence: 0.7, answer });
    await decided(wallet, { luca: 'internal_transfer', confidence: 0.7, answer: 'revenue' });

    const q = await getQualityBaseline({ userId: user.id, days: 7 });
    const revenue = q.decisions.by_label.find((l) => l.label === 'revenue')!;
    expect(revenue).toMatchObject({ reviewed: 5, confirmed: 3, precision: { rate: 0.6 }, actually: { internal_transfer: 1, refund: 1 } });
    const expense = q.decisions.by_label.find((l) => l.label === 'expense')!;
    expect(expense.precision).toEqual({ num: 3, den: 4, rate: null });
    expect(q.warnings).toEqual(['Reviewed precision for revenue is 60% (3 of 5 reviewed), below 80%.']);
    expect(q.decisions.internal).toEqual({ wrongly_internal: 1, missed_internal: 1 });
  });

  it('two clocks: a decision counts when it was made, the transfer counts when it happened', async () => {
    const { user, wallet } = await seedUserWithWallet();
    // Happened 20 days ago, corrected today: a decision this week, not a transfer this week
    await decided(wallet, { luca: 'revenue', answer: 'expense', happenedAt: '20 days', lucaAt: '19 days', answerAt: '1 hour' });
    // Happened 12 days ago and decided 10 days ago: in neither this week
    await decided(wallet, { luca: 'revenue', answer: 'revenue', happenedAt: '12 days', lucaAt: '11 days', answerAt: '10 days' });
    // Happened this week, never reviewed; and one still unknown
    await insertClassifiedEvent({ wallet, direction: 'in', amount: 5, usdValue: 5, label: 'revenue', at: '2 days' });
    await insertClassifiedEvent({ wallet, direction: 'in', amount: 7, usdValue: 7, label: 'unknown', at: '1 day' });

    const q = await getQualityBaseline({ userId: user.id, days: 7 });
    expect(q.decisions).toMatchObject({ reviewed: 1, corrected: 1, confirmed: 0 });
    expect(q.activity).toMatchObject({ movements: 2, still_unknown: 1, still_unknown_usd: 7, unreviewed: 2, unknown_rate: { num: 1, den: 2, rate: 0.5 } });
    const month = await getQualityBaseline({ userId: user.id, days: 30 });
    expect(month.decisions).toMatchObject({ reviewed: 2, corrected: 1, confirmed: 1 });
    expect(month.activity.movements).toBe(4);
  });

  it('learned rules: later matches split into reviewed (confirmed / corrected) and unreviewed; never "stayed correct"', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const vendor = addr();
    const ruleId = await insertCounterpartyRule({ userId: user.id, address: vendor, label: 'expense', direction: 'out' });
    await sql(`UPDATE counterparty_rules SET created_at = NOW() - INTERVAL '10 days' WHERE id = $1`, [ruleId]);
    // Later transfers the rule labeled
    await decided(wallet, { counterparty: vendor, direction: 'out', luca: 'expense', method: 'counterparty', ruleId, answer: 'expense', happenedAt: '3 days', lucaAt: '3 days', answerAt: '2 days' });
    await decided(wallet, { counterparty: vendor, direction: 'out', luca: 'expense', method: 'counterparty', ruleId, answer: 'refund', happenedAt: '3 days', lucaAt: '3 days', answerAt: '2 days' });
    const unreviewed = await insertEvent({ wallet, direction: 'out', counterparty: vendor, amount: 3, at: '1 day' });
    const c = await insertClassification({ eventId: unreviewed.id, userId: user.id, label: 'expense', method: 'counterparty', confidence: 1 });
    await sql(`UPDATE classifications SET rule_id = $2 WHERE id = $1`, [c, ruleId]);
    // A transfer from before the rule existed, relabeled by it later: not a later match
    const earlier = await insertEvent({ wallet, direction: 'out', counterparty: vendor, amount: 4, at: '15 days' });
    const e = await insertClassification({ eventId: earlier.id, userId: user.id, label: 'expense', method: 'counterparty', confidence: 1 });
    await sql(`UPDATE classifications SET rule_id = $2 WHERE id = $1`, [e, ruleId]);

    const q = await getQualityBaseline({ userId: user.id, days: 7 });
    expect(q.rules).toMatchObject({ rules: 1, matched: 3, reviewed: 2, confirmed: 1, corrected: 1, unreviewed: 1, precision: { num: 1, den: 2, rate: null } });
    const text = describeQuality(q, 'your wallets');
    expect(text).toContain('- 1 rule; 3 later transfers labeled by them: 2 reviewed (1 confirmed, 1 corrected), 1 unreviewed');
    expect(text).toContain('- Reviewed rule precision: too few to judge: 1 confirmed of 2 reviewed rule matches (needs at least 5)');
    expect(text).not.toMatch(/stayed correct/i);
  });

  it('rules for addresses Luca does not book cannot take effect: listed separately, never counted as learned', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const spam = addr();
    const vendor = addr();
    const oneWay = addr();
    await insertEvent({ wallet, direction: 'in', counterparty: spam, asset: 'SCAM', amount: 1000000 });   // unsupported token
    await insertEvent({ wallet, direction: 'out', counterparty: vendor, amount: 5 });
    await insertEvent({ wallet, direction: 'out', counterparty: oneWay, amount: 5 });
    await insertCounterpartyRule({ userId: user.id, address: spam, label: 'revenue', direction: 'in' });
    await insertCounterpartyRule({ userId: user.id, address: vendor, label: 'expense', direction: 'out' });
    await insertCounterpartyRule({ userId: user.id, address: oneWay, label: 'revenue', direction: 'in' });  // only outgoing transfers booked
    await insertCounterpartyRule({ userId: user.id, address: addr(), label: 'gas', direction: null });      // no transfers at all

    const q = await getQualityBaseline({ userId: user.id, days: 7 });
    expect(q.decisions).toMatchObject({ rules_learned: 1, rules_learned_inert: 3 });
    expect(q.rules).toMatchObject({ rules: 1, inert: 3 });
    const text = describeQuality(q, 'your wallets');
    expect(text).toContain('- Rules learned: 1 (3 more are for addresses Luca does not book, such as unsupported tokens, and cannot take effect; not counted)');
    expect(describeQualityShort(q)[3]).toMatch(/^ {2}Rules: 1 \(\+3 that cannot take effect\)/);
  });

  it('a repeated mistake counts only where the learned rule was meant to apply', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const vendor = addr();
    // Taught: payments to the vendor are expenses; the rule is learned at the same time
    await decided(wallet, { counterparty: vendor, direction: 'out', luca: 'revenue', answer: 'expense', lucaAt: '5 days', answerAt: '4 days', happenedAt: '5 days' });
    const ruleId = await insertCounterpartyRule({ userId: user.id, address: vendor, label: 'expense', direction: 'out' });
    await sql(`UPDATE counterparty_rules SET created_at = NOW() - INTERVAL '4 days' WHERE id = $1`, [ruleId]);

    const later = async (o: { direction?: 'in' | 'out'; sourceKey?: string; shape?: string; method?: 'model' | 'deterministic'; label?: Label }) => {
      const ev = await insertEvent({ wallet, direction: o.direction ?? 'out', counterparty: vendor, amount: 9, at: '1 day', sourceKey: o.sourceKey });
      const c = await insertClassification({ eventId: ev.id, userId: user.id, label: o.label ?? 'revenue', method: o.method ?? 'model', createdAt: '1 day' });
      if (o.shape) await sql(`UPDATE classifications SET shape = $2 WHERE id = $1`, [c, o.shape]);
      return ev;
    };
    const repeated = await later({});
    await later({ direction: 'in' });                    // other direction: the rule does not apply
    await later({ sourceKey: 'gas', label: 'gas' });     // a fee
    await later({ shape: 'swap', label: 'swap' });       // decided by a whole-transaction check
    await later({ shape: 'complex', label: 'unknown' }); // complex transaction
    await later({ method: 'deterministic', label: 'internal_transfer' });

    let q = await getQualityBaseline({ userId: user.id, days: 7 });
    expect(q.rules.repeated_mistakes).toEqual([{ hash: repeated.hash, luca: 'revenue', taught: 'expense' }]);
    expect(q.warnings).toContain('Luca repeated a mistake it had been taught 1 time.');

    // With the rule switched off before that label was made, it was not meant to apply
    await sql(`UPDATE counterparty_rules SET active = FALSE, disabled_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [ruleId]);
    q = await getQualityBaseline({ userId: user.id, days: 7 });
    expect(q.rules.repeated_mistakes).toEqual([]);
  });

  it('the gold set is reported on its own and never changes the live review numbers', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await decided(wallet, { luca: 'revenue', answer: 'expense' });
    const before = await getQualityBaseline({ userId: user.id, days: 7 });
    for (const [label, gold] of [['revenue', 'revenue'], ['expense', 'expense'], ['revenue', 'refund']] as const) {
      const ev = await insertClassifiedEvent({ wallet, direction: 'in', amount: 1, label, at: '30 days' });
      await sql(`INSERT INTO gold_transactions (user_id, event_id, correct_label, added_by) VALUES ($1, $2, $3, 'user')`, [user.id, ev.id, gold]);
    }
    const after = await getQualityBaseline({ userId: user.id, days: 7 });
    expect(after.decisions).toEqual(before.decisions);
    expect(after.gold).toEqual({ examples: 3, matching: 2, rate: { num: 2, den: 3, rate: null } });
  });

  it('all operators are summed from raw counts, not averaged; each operator only sees their own', async () => {
    const a = await seedUserWithWallet();
    const b = await seedUserWithWallet();
    // a: 1 corrected of 1 (100%); b: 0 corrected of 5 (0%). Averaging would say 50%.
    await decided(a.wallet, { luca: 'revenue', answer: 'expense' });
    for (let i = 0; i < 5; i++) await decided(b.wallet, { luca: 'expense', answer: 'expense' });

    const everyone = await all();
    expect(everyone.decisions.correction_rate).toEqual({ num: 1, den: 6, rate: 1 / 6 });
    expect((await getQualityBaseline({ userId: a.user.id, days: 7 })).decisions.reviewed).toBe(1);
    expect((await getQualityBaseline({ userId: b.user.id, days: 7 })).decisions).toMatchObject({ reviewed: 5, corrected: 0 });
  });

  it('the report says what each number is based on, and never calls it overall accuracy', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await decided(wallet, { luca: 'revenue', answer: 'expense' });
    const text = describeQuality(await getQualityBaseline({ userId: user.id, days: 7 }), 'your wallets');
    expect(text).toMatch(/^Classification quality: your wallets\n\nTransfers that happened in the last 7 days:/);
    expect(text).toContain("Operator decisions made in the last 7 days, whatever the transfer's date:");
    expect(text).toContain('- Correction rate: too few to judge: 1 corrected of 1 reviewed labels (needs at least 5)');
    expect(text).toContain('- Reviewed precision by label (confirmed of reviewed; not overall accuracy):');
    expect(text).toContain('  - expense: no reviewed yet');
    expect(text).toContain('Gold set (curated examples, kept separate from live reviews):');
    expect(text).not.toMatch(/overall accuracy is|accuracy:/i);
    expect(describeQualityShort(await all())).toHaveLength(5);
  });

  it('the admin question: admins only, all operators or one by @username, as a finished report', async () => {
    const admin = await insertUser({ role: 'admin', username: 'founder' });
    const alice = await seedUserWithWallet({ username: 'alice' });
    await decided(alice.wallet, { luca: 'revenue', answer: 'expense' });

    expect(await executeAdminTool(alice.user.id, 'admin_get_classification_quality', {})).toEqual({ error: 'Not available.' });
    const everyone = await executeAdminTool(admin.id, 'admin_get_classification_quality', {}) as { report: string };
    expect(everyone.report).toMatch(/^Classification quality: all operators/);
    const one = await executeAdminTool(admin.id, 'admin_get_classification_quality', { username: '@alice', days: 30 }) as { report: string };
    expect(one.report).toMatch(/^Classification quality: @alice\n\nTransfers that happened in the last 30 days:/);
    expect(await executeAdminTool(admin.id, 'admin_get_classification_quality', { username: 'nobody' })).toEqual({ error: 'No user @nobody.' });
  });

  describe('rounded amounts in transaction tools', () => {
    it('a single transaction and the unknown list carry a ready-made amount', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const ev = await insertClassifiedEvent({ wallet, direction: 'in', asset: 'ETH', amount: '0.001499703666736745', usdValue: 4.06, label: 'unknown' });
      const one = await executeTool(user.id, 'get_transaction', { event_id: ev.hash }) as { event: { amount_display: string } };
      expect(one.event.amount_display).toBe('0.0014997 ETH');
      const unknown = await executeTool(user.id, 'get_unknown_transactions', {}) as { events: Array<{ amount_display: string }> };
      expect(unknown.events[0].amount_display).toBe('0.0014997 ETH');
    });
  });
});
