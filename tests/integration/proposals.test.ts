// Integration: earlier entries in the books never change without the operator's yes.
// A correction that teaches (or switches off) a rule stores a proposal and asks; a bare
// "yes"/"no" answers only the one current question; anything else asks which one; an
// explicit answer goes through the model's answer_proposal tool, checked against the
// operator's own words. Real Postgres; the model is scripted.
import { it, expect, vi, beforeEach, describe } from 'vitest';

vi.hoisted(() => { process.env.AGENT_MODEL = 'gpt-4o'; });
const create = vi.fn();
let responses: unknown[] = [];
vi.mock('openai', () => ({
  default: class { chat = { completions: { create: (...a: unknown[]) => { create(...a); return Promise.resolve(responses.shift()); } } }; },
}));
vi.mock('../../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<{ config: Record<string, unknown> }>();
  return { ...orig, config: { ...orig.config, OPENAI_API_KEY: 'test' } };
});
vi.mock('../../src/agent/system.js', () => ({ buildSystemPrompt: vi.fn(() => Promise.resolve('system')) }));
vi.mock('../../src/ingestion/price.js', () => ({
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
  enrichUsdValue: vi.fn(),
}));

import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertClassifiedEvent, insertEvent, sql, addr, type WalletFx,
} from './helpers/db.js';
import { applyCorrection, describeRuleOutcome, type RuleOutcome } from '../../src/corrections/handler.js';
import { answerProposal, pendingProposals } from '../../src/corrections/proposals.js';
import { labelQuestionGroup, refreshQuestionGroups, getQuestionsToSend } from '../../src/alerts/questions.js';
import { classifyPendingEvents } from '../../src/classification/engine.js';
import { saveMessage } from '../../src/agent/context.js';
import { runAgent } from '../../src/agent/run.js';

type Active = { label: string; source: string | null; method: string; rule_id: string | null };
async function active(eventId: string): Promise<Active> {
  const rows = await sql<Active>(
    `SELECT label::text, source, method, rule_id FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`, [eventId],
  );
  return rows[0];
}
const proposalOf = (r: RuleOutcome): { id: string; count: number; question: string } =>
  (r as { proposal: { id: string; count: number; question: string } }).proposal;

function say(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}
function callAnswer(proposal_id: string, accept: boolean) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'answer_proposal', arguments: JSON.stringify({ proposal_id, accept }) } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

// Three earlier payments to a vendor labeled by the model, then the operator corrects a new one
async function seedVendor(wallet: WalletFx, vendor = addr()) {
  const earlier = [];
  for (const [label, at] of [['expense', '5 days'], ['unknown', '4 days'], ['refund', '3 days']] as const) {
    earlier.push(await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, amount: 12, usdValue: 12, label, method: 'model', at }));
  }
  const latest = await insertEvent({ wallet, direction: 'out', counterparty: vendor, amount: 20, usdValue: 20, at: '1 hour' });
  return { vendor, earlier, latest };
}

// The operator writes in chat, as the bot would record it
async function operatorSays(userId: string, text: string) {
  return runAgent({ userId, userMessage: text, role: 'operator' });
}

describeDb('changing earlier entries needs a yes (integration)', () => {
  useIntegrationDb();
  beforeEach(() => { create.mockClear(); responses = []; });

  it('a correction asks about earlier transfers and changes none of them', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const { earlier, latest } = await seedVendor(wallet);

    const result = await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' });
    const p = proposalOf(result.rule);
    // The refund one already has the label; the other two would change
    expect(p.count).toBe(2);
    expect(p.question).toMatch(/^I found 2 earlier payments to 0x\w{4}…\w{4} that the same rule covers \(1 labeled expense, 1 unknown\)\. Want me to label them refund too\?/);
    expect(p.question.split('\n').slice(1)).toHaveLength(2);
    for (const line of p.question.split('\n').slice(1)) expect(line).toMatch(/^- \w{3} \d+ {2}12 USDC {2}\[0x\w{4}…\w{4}\]\(https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}\)$/);
    expect(describeRuleOutcome(result.rule)).toBe(`New transfers with this address will be labeled the same way. I haven't changed any earlier ones.\n\n${p.question}`);

    expect((await active(earlier[0].id)).label).toBe('expense');
    expect((await active(earlier[1].id)).label).toBe('unknown');
    expect(await active(latest.id)).toMatchObject({ label: 'refund', source: 'user' });
  });

  it('"yes" to the current question relabels exactly the proposed transfers; the answer is in code, not the model', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const { earlier, latest } = await seedVendor(wallet);
    await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' });

    const r = await operatorSays(user.id, 'yes');
    expect(create).not.toHaveBeenCalled();
    expect(r.text).toMatch(/^Done\. 2 earlier payments to 0x\w{4}…\w{4} are now refund\.$/);
    expect(await active(earlier[0].id)).toMatchObject({ label: 'refund', method: 'counterparty', source: null });
    expect((await active(earlier[1].id)).label).toBe('refund');
    expect(await pendingProposals(user.id)).toEqual([]);
  });

  it('"no" changes nothing, and new transfers still follow the rule', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const { vendor, earlier, latest } = await seedVendor(wallet);
    await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' });

    const r = await operatorSays(user.id, 'no thanks');
    expect(r.text).toMatch(/^OK, I left the 2 earlier payments to 0x\w{4}…\w{4} as they were\. New ones will still be labeled refund\.$/);
    expect((await active(earlier[0].id)).label).toBe('expense');
    const next = await insertEvent({ wallet, direction: 'out', counterparty: vendor, amount: 5, usdValue: 5 });
    await classifyPendingEvents(user.id);
    expect((await active(next.id)).label).toBe('refund');
  });

  it('an expired question cannot be accepted', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const { earlier, latest } = await seedVendor(wallet);
    const p = proposalOf((await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' })).rule);
    await sql(`UPDATE label_proposals SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [p.id]);

    expect(await answerProposal({ userId: user.id, proposalId: p.id, accept: true })).toMatchObject({ ok: false, reason: 'not_pending' });
    // Nothing open any more: a "yes" is an ordinary message for the model
    responses = [say('What would you like me to do?')];
    const r = await operatorSays(user.id, 'yes');
    expect(r.text).not.toMatch(/^Done/);
    expect((await active(earlier[0].id)).label).toBe('expense');
    expect((await sql<{ status: string }>(`SELECT status FROM label_proposals WHERE id = $1`, [p.id]))[0].status).toBe('expired');
  });

  it('a transfer the operator labeled after the question is left alone, and the reply says so', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const { earlier, latest } = await seedVendor(wallet);
    const p = proposalOf((await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' })).rule);
    // The operator labels one of them themselves in the meantime (a label, not a new rule)
    await sql(`UPDATE classifications SET superseded_at = NOW() WHERE event_id = $1 AND superseded_at IS NULL`, [earlier[0].id]);
    await sql(`INSERT INTO classifications (event_id, user_id, label, confidence, method, evidence, source) VALUES ($1, $2, 'refund', 1, 'counterparty', 'mine', 'user')`, [earlier[0].id, user.id]);

    const r = await answerProposal({ userId: user.id, proposalId: p.id, accept: true });
    expect(r).toMatchObject({ ok: true, changed: 1, skipped: 1 });
    expect(r.text).toMatch(/^Done\. 1 earlier payment to 0x\w{4}…\w{4} is now refund\. I left 1 alone because it changed since I asked/);
    expect(await active(earlier[0].id)).toMatchObject({ label: 'refund', source: 'user' });
    expect((await active(earlier[1].id)).label).toBe('refund');
  });

  it("another operator can never answer someone's question", async () => {
    const alice = await seedUserWithWallet();
    const bob = await seedUserWithWallet();
    const { earlier, latest } = await seedVendor(alice.wallet);
    const p = proposalOf((await applyCorrection({ userId: alice.user.id, eventId: latest.id, newLabel: 'refund' })).rule);

    expect(await answerProposal({ userId: bob.user.id, proposalId: p.id, accept: true })).toMatchObject({ ok: false, reason: 'not_found' });
    // Bob has no open question: his "yes" is an ordinary message for the model
    responses = [say('What would you like me to do?')];
    const r = await operatorSays(bob.user.id, 'yes');
    expect(r.text).not.toMatch(/^Done/);
    expect((await active(earlier[0].id)).label).toBe('expense');
    expect(await pendingProposals(alice.user.id)).toHaveLength(1);
  });

  it('a bare "yes" after the conversation moved on asks which question, and "yes to 1" answers it', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const { earlier, latest } = await seedVendor(wallet);
    await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' });
    await saveMessage({ userId: user.id, role: 'user', content: 'what did gas cost this week?' });

    const r = await operatorSays(user.id, 'yes');
    expect(create).not.toHaveBeenCalled();
    expect(r.text).toMatch(/^Just to be sure, do you mean this question I asked earlier\?\n\n1\. \(.+\) I found 2 earlier payments/);
    expect(r.text).toMatch(/Reply "yes to 1" or "no to 1"\. Until then I won't change anything\.$/);
    expect((await active(earlier[0].id)).label).toBe('expense');

    const done = await operatorSays(user.id, 'yes to 1');
    expect(done.text).toMatch(/^Done\. 2 earlier payments/);
    expect((await active(earlier[0].id)).label).toBe('refund');
  });

  it('with two questions open, a bare "yes" answers neither and lists both', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const a = await seedVendor(wallet);
    const b = await seedVendor(wallet);
    await applyCorrection({ userId: user.id, eventId: a.latest.id, newLabel: 'refund' });
    await applyCorrection({ userId: user.id, eventId: b.latest.id, newLabel: 'expense' });

    const r = await operatorSays(user.id, 'yes');
    expect(r.text).toMatch(/^I have 2 open questions for you\. Which one do you mean\?\n\n1\. .+refund too\?\n2\. .+expense too\?/);
    expect((await active(a.earlier[0].id)).label).toBe('expense');
    expect((await active(b.earlier[1].id)).label).toBe('unknown');

    await operatorSays(user.id, 'no to 2');
    await operatorSays(user.id, 'yes to 1');
    expect((await active(a.earlier[1].id)).label).toBe('refund');
    expect((await active(b.earlier[1].id)).label).toBe('unknown');
  });

  it('an explicit answer through the model resolves the question it names, in the change\'s own words', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const { earlier, latest } = await seedVendor(wallet);
    const p = proposalOf((await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' })).rule);

    responses = [callAnswer(p.id, true), say('Done, I updated them all to refund and more!')];
    const r = await operatorSays(user.id, 'yes please update those earlier payments too');
    expect(r.text).toMatch(/^Done\. 2 earlier payments to 0x\w{4}…\w{4} are now refund\.$/);
    expect((await active(earlier[0].id)).label).toBe('refund');
  });

  it("the model cannot answer a question the operator's words do not answer", async () => {
    const { user, wallet } = await seedUserWithWallet();
    const { earlier, latest } = await seedVendor(wallet);
    const p = proposalOf((await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' })).rule);

    responses = [callAnswer(p.id, true), say('Which question do you mean?')];
    const r = await operatorSays(user.id, 'hmm, what were those payments for again?');
    expect(r.text).toBe('Which question do you mean?');
    expect((await active(earlier[0].id)).label).toBe('expense');
    expect(await pendingProposals(user.id)).toHaveLength(1);
  });

  describe('the question covers exactly what the rule covers', () => {
    // (An address seen in a swap never gets a rule at all: smarter-classification.test.ts)
    it('never the other direction, a complex transaction, a deterministic label, the operator\'s own labels or a transfer still waiting for a label', async () => {
      const { user, wallet } = await seedUserWithWallet();
      const vendor = addr();
      const single = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, label: 'expense', method: 'model' });
      const incoming = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: vendor, label: 'unknown', method: 'model' });
      const decided = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, label: 'internal_transfer', method: 'deterministic' });
      const complexLeg = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, label: 'unknown', method: 'model' });
      await sql(`UPDATE classifications SET shape = 'complex' WHERE event_id = $1`, [complexLeg.id]);
      const mine = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, label: 'refund', method: 'counterparty', source: 'user' });
      const retrying = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, label: 'unknown', method: 'model', source: 'failure' });
      const latest = await insertEvent({ wallet, direction: 'out', counterparty: vendor });

      const p = proposalOf((await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' })).rule);
      const ids = (await sql<{ event_ids: string[] }>(`SELECT event_ids FROM label_proposals WHERE id = $1`, [p.id]))[0].event_ids;
      expect(ids).toEqual([single.id]);
      void [incoming, decided, complexLeg, mine, retrying];
    });
  });

  it('a grouped question still applies to exactly its group; other earlier transfers are asked about', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const cp = addr();
    const auto = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: cp, amount: 300, usdValue: 300, label: 'refund', method: 'model', at: '8 days' });
    const group = [];
    for (const at of ['3 days', '2 days']) {
      group.push(await insertClassifiedEvent({ wallet, direction: 'out', counterparty: cp, amount: 400, usdValue: 400, label: 'unknown', at }));
    }
    await refreshQuestionGroups(user.id);
    const q = (await getQuestionsToSend()).find((x) => x.user_id === user.id)!;

    const answer = await labelQuestionGroup(q.id, user.id, 'expense');
    expect(answer).toMatchObject({ ok: true, labeled: 2, rule: { kind: 'learned', proposal: { count: 1 } } });
    for (const e of group) expect((await active(e.id)).label).toBe('expense');
    expect((await active(auto.id)).label).toBe('refund');
  });

  it('switching off a rule asks before sending its earlier labels back', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const cp = addr();
    const first = await insertEvent({ wallet, direction: 'out', counterparty: cp, amount: 30, usdValue: 30 });
    await applyCorrection({ userId: user.id, eventId: first.id, newLabel: 'expense' });
    const x = await insertEvent({ wallet, direction: 'out', counterparty: cp, amount: 20, usdValue: 20 });
    const y = await insertEvent({ wallet, direction: 'out', counterparty: cp, amount: 25, usdValue: 25 });
    await classifyPendingEvents(user.id);

    const result = await applyCorrection({ userId: user.id, eventId: x.id, newLabel: 'refund' });
    const p = proposalOf(result.rule);
    expect(describeRuleOutcome(result.rule)).toMatch(/^That contradicts the rule I had for this address, so I switched it off\.\n\nThat rule had labeled 1 earlier payment to 0x\w{4}…\w{4} as expense\. Want me to send it back to unknown, so you can tell me what it was\?/);
    expect((await active(y.id)).label).toBe('expense');

    const r = await operatorSays(user.id, 'yes');
    expect(r.text).toMatch(/^Done\. 1 earlier payment to 0x\w{4}…\w{4} is back to unknown, and I'll ask you about it\.$/);
    expect((await active(y.id)).label).toBe('unknown');
    void p;
  });

  it('a newer answer about the same address replaces the open question', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const { vendor, earlier, latest } = await seedVendor(wallet);
    const old = proposalOf((await applyCorrection({ userId: user.id, eventId: latest.id, newLabel: 'refund' })).rule);
    const again = await insertEvent({ wallet, direction: 'out', counterparty: vendor, amount: 9, usdValue: 9 });
    // Contradicts the rule just learned: it is switched off, so its question no longer applies
    await applyCorrection({ userId: user.id, eventId: again.id, newLabel: 'expense' });

    expect((await sql<{ status: string }>(`SELECT status FROM label_proposals WHERE id = $1`, [old.id]))[0].status).toBe('superseded');
    expect(await answerProposal({ userId: user.id, proposalId: old.id, accept: true })).toMatchObject({ ok: false });
    expect((await active(earlier[0].id)).label).toBe('expense');
  });
});
