// Integration: changes the operator asks for in chat, with no buttons. The model's write
// call becomes Luca's own question; the change waits in label_proposals until the
// operator answers, and is validated again when they say yes. Grouped questions are
// answered in chat the same way. Real Postgres; the model is scripted.
import { it, expect, vi, beforeEach } from 'vitest';

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

import { describeDb, useIntegrationDb, seedUserWithWallet, insertClassifiedEvent, insertEvent, sql, addr } from './helpers/db.js';
import { runAgent } from '../../src/agent/run.js';
import { executeTool } from '../../src/agent/tools.js';
import { pendingProposals } from '../../src/corrections/proposals.js';
import { refreshQuestionGroups, getQuestionsToSend, markQuestionSent } from '../../src/alerts/questions.js';
import { questionText } from '../../src/telegram/alerts.js';
import { saveMessage } from '../../src/agent/context.js';

const link = (h: string): string => `[${h.slice(0, 6)}…${h.slice(-4)}](https://basescan.org/tx/${h})`;

function say(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}
function calls(...c: Array<[string, Record<string, unknown>]>) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: c.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}
async function label(eventId: string): Promise<{ label: string; source: string | null }> {
  return (await sql<{ label: string; source: string | null }>(
    `SELECT label::text, source FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`, [eventId],
  ))[0];
}
const says = (userId: string, text: string) => runAgent({ userId, userMessage: text, role: 'operator' });

describeDb('changes by chat, no buttons (integration)', () => {
  useIntegrationDb();
  beforeEach(() => { create.mockClear(); responses = []; });

  it('a correction becomes Luca\'s own question; nothing changes until "yes"', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'UTC' });
    const ev = await insertClassifiedEvent({ wallet, direction: 'in', asset: 'ETH', amount: '0.001499703666736745', usdValue: 4.06, label: 'unknown', at: '1 hour' });

    responses = [calls(['apply_correction', { event_id: ev.hash, new_label: 'revenue' }]), say('')];
    const r = await says(user.id, `${ev.hash.slice(0, 10)} was revenue`);
    expect(r).toEqual({ text: expect.stringMatching(/^Label the 0\.0014997 ETH you received on \w{3} \d+ \(/) as string });
    expect(r.text).toBe(`Label the 0.0014997 ETH you received on ${r.text.match(/on (\w{3} \d+)/)![1]} (${link(ev.hash)}) as revenue?`);
    expect((await label(ev.id)).label).toBe('unknown');

    create.mockClear();
    const done = await says(user.id, 'yes');
    expect(create).not.toHaveBeenCalled();
    expect(done.text).toMatch(/^Done\. Labeled the 0\.0014997 ETH you received on .+ as revenue\. New transfers with this address will be labeled the same way\.$/);
    expect(await label(ev.id)).toEqual({ label: 'revenue', source: 'user' });
  });

  it('"no" changes nothing', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const ev = await insertClassifiedEvent({ wallet, direction: 'in', amount: 12, usdValue: 12, label: 'unknown' });
    responses = [calls(['apply_correction', { event_id: ev.id, new_label: 'revenue' }]), say('')];
    await says(user.id, 'that was revenue');
    expect((await says(user.id, 'no')).text).toBe("OK, I haven't changed anything.");
    expect((await label(ev.id)).label).toBe('unknown');
  });

  it('the model saying it is done, or asking itself, never reaches the operator', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const ev = await insertClassifiedEvent({ wallet, direction: 'in', amount: 12, usdValue: 12, label: 'unknown' });
    for (const claim of ['Done! I have labeled it as revenue.', "I'll label that as revenue for you.", 'Should I label it as revenue?']) {
      responses = [calls(['apply_correction', { event_id: ev.id, new_label: 'revenue' }]), say(claim)];
      const r = await says(user.id, 'that was revenue');
      expect(r.text, claim).toMatch(/^Label the 12 USDC you received on .+ as revenue\?$/);
    }
    expect((await label(ev.id)).label).toBe('unknown');
  });

  it('keeps the answer to anything else they asked, and ends with the question', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const ev = await insertClassifiedEvent({ wallet, direction: 'in', amount: 12, usdValue: 12, label: 'unknown' });
    responses = [
      calls(['get_books_summary', { period_days: 7 }], ['apply_correction', { event_id: ev.id, new_label: 'revenue' }]),
      say('You paid $0.01 in network fees this week.'),
    ];
    const r = await says(user.id, 'what did gas cost this week? also that 12 USDC was revenue');
    expect(r.text).toMatch(/^You paid \$0\.01 in network fees this week\.\n\nLabel the 12 USDC you received on .+ as revenue\?$/);
  });

  it('several changes are listed before "yes"; one that became invalid is skipped and the reply says exactly what was made', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const a = await insertClassifiedEvent({ wallet, direction: 'in', amount: 12, usdValue: 12, label: 'unknown' });
    const b = await insertClassifiedEvent({ wallet, direction: 'out', amount: 5, usdValue: 5, label: 'unknown' });
    const other = addr();
    responses = [
      calls(['apply_correction', { event_id: a.id, new_label: 'revenue' }], ['apply_correction', { event_id: b.id, new_label: 'expense' }],
        ['register_wallet', { address: other, label: 'ops' }]),
      say(''),
    ];
    const q = await says(user.id, 'a was revenue, b was an expense, and track my ops wallet');
    const lines = q.text.split('\n');
    expect(lines[0]).toBe('Make these 3 changes?');
    expect(lines[1]).toMatch(/^1\. Label the 12 USDC you received on .+ as revenue$/);
    expect(lines[2]).toMatch(/^2\. Label the 5 USDC you sent on .+ as expense$/);
    expect(lines[3]).toBe(`3. Track wallet ${other} on Base as "ops"`);
    expect(lines.at(-1)).toBe('Reply yes or no.');

    // Before the answer, one of them stops being a transaction Luca books
    await sql(`UPDATE normalized_events SET supported = FALSE WHERE id = $1`, [b.id]);
    const done = await says(user.id, 'yes');
    expect(done.text).toMatch(/^I made 2 of the 3 changes:\n- Labeled the 12 USDC you received on .+ as revenue\n- Started tracking wallet 0x\w{4}…\w{4} as "ops"\n\nNot made:\n- Label the 5 USDC you sent on .+ as expense: I could not find that transaction in your books any more/);
    expect((await label(a.id)).label).toBe('revenue');
    expect((await label(b.id)).label).toBe('unknown');
    expect(await sql(`SELECT 1 FROM wallets WHERE user_id = $1 AND address = $2`, [user.id, other])).toHaveLength(1);
  });

  it('a wallet that is not a Base address never becomes a question', async () => {
    const { user } = await seedUserWithWallet();
    responses = [calls(['register_wallet', { address: 'not-an-address' }]), say("That doesn't look like a Base wallet address.")];
    const r = await says(user.id, 'track not-an-address');
    expect(r.text).toBe("That doesn't look like a Base wallet address.");
    expect(await pendingProposals(user.id)).toEqual([]);
  });

  it('a grouped question is answered in chat: "those are expenses" becomes a question, "yes" labels the group', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const cp = addr();
    const evs = [];
    for (const [usd, at] of [[400, '20 days'], [300, '10 days'], [340, '5 days'], [200, '1 day']] as const) {
      evs.push(await insertClassifiedEvent({ wallet, direction: 'out', counterparty: cp, amount: usd, usdValue: usd, at, label: 'unknown' }));
    }
    await refreshQuestionGroups(user.id);
    const g = (await getQuestionsToSend()).find((x) => x.user_id === user.id)!;
    expect(questionText(g)).toMatch(/^I have 4 similar USDC payments to `0x\w{4}…\w{4}` that still need context \(\$1,240\.00 total, .+\)\. They look related\. What were they for\?$/);
    await markQuestionSent(g.id, 1);
    await saveMessage({ userId: user.id, role: 'assistant', content: questionText(g) });

    responses = [calls(['label_question_group', { group_id: g.id, label: 'expense' }]), say('Got it.')];
    const q = await says(user.id, 'those are infrastructure costs');
    expect(q.text).toMatch(/^Got it\.\n\nLabel those 4 USDC payments to 0x\w{4}…\w{4} \(.+ to .+, \$1,240\.00 total\) as expense\?$/);
    for (const e of evs) expect((await label(e.id)).label).toBe('unknown');

    const done = await says(user.id, 'yes');
    expect(done.text).toMatch(/^Done\. Labeled those 4 USDC payments to .+ as expense\. New transfers with this address will be labeled the same way\.$/);
    for (const e of evs) expect(await label(e.id)).toEqual({ label: 'expense', source: 'user' });
  });

  it('"not sure" about a group skips it without changing anything', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const ev = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 900, usdValue: 900, label: 'unknown' });
    await refreshQuestionGroups(user.id);
    const g = (await getQuestionsToSend()).find((x) => x.user_id === user.id)!;
    await markQuestionSent(g.id, 1);
    responses = [calls(['skip_question_group', { group_id: g.id }]), say("No problem, I won't ask about it again unless more like it arrive.")];
    await says(user.id, 'not sure, skip it');
    expect((await sql<{ status: string }>(`SELECT status FROM question_groups WHERE id = $1`, [g.id]))[0].status).toBe('skipped');
    expect((await label(ev.id)).label).toBe('unknown');
  });

  it("after a correction, the rule's question about earlier transfers is the next current question", async () => {
    const { user, wallet } = await seedUserWithWallet();
    const vendor = addr();
    const earlier = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: vendor, amount: 12, usdValue: 12, label: 'expense', method: 'model', at: '5 days' });
    const latest = await insertEvent({ wallet, direction: 'out', counterparty: vendor, amount: 20, usdValue: 20, at: '1 hour' });
    responses = [calls(['apply_correction', { event_id: latest.id, new_label: 'revenue' }]), say('')];
    await says(user.id, 'the 20 USDC payment was revenue');

    const done = await says(user.id, 'yes');
    expect(done.text).toMatch(/^Done\. Labeled the 20 USDC you sent on .+ as revenue\. New transfers with this address will be labeled the same way\. I haven't changed any earlier ones\.\n\nI found 1 earlier payment to .+ Want me to label it revenue too\?/);
    expect((await label(earlier.id)).label).toBe('expense');

    const again = await says(user.id, 'yes');
    expect(again.text).toMatch(/^Done\. 1 earlier payment to .+ is now revenue\.$/);
    expect((await label(earlier.id)).label).toBe('revenue');
  });

  it('a change waits a day at most, and another operator can never answer it', async () => {
    const alice = await seedUserWithWallet();
    const bob = await seedUserWithWallet();
    const ev = await insertClassifiedEvent({ wallet: alice.wallet, direction: 'in', amount: 12, usdValue: 12, label: 'unknown' });
    responses = [calls(['apply_correction', { event_id: ev.id, new_label: 'revenue' }]), say('')];
    await says(alice.user.id, 'that was revenue');

    responses = [say('What would you like me to do?')];
    await says(bob.user.id, 'yes');
    expect((await label(ev.id)).label).toBe('unknown');

    const expires = (await sql<{ hours: number }>(`SELECT EXTRACT(EPOCH FROM expires_at - created_at) / 3600 AS hours FROM label_proposals WHERE user_id = $1`, [alice.user.id]))[0];
    expect(Number(expires.hours)).toBe(24);
    await sql(`UPDATE label_proposals SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [alice.user.id]);
    responses = [say('What would you like me to do?')];
    await says(alice.user.id, 'yes');
    expect((await label(ev.id)).label).toBe('unknown');
  });

  it("nothing is written on the model's word: the model cannot confirm what the operator did not say, and the write tools themselves refuse", async () => {
    const { user, wallet } = await seedUserWithWallet();
    const ev = await insertClassifiedEvent({ wallet, direction: 'in', amount: 12, usdValue: 12, label: 'unknown', asset: 'USDC' });
    responses = [calls(['apply_correction', { event_id: ev.id, new_label: 'revenue' }]), say('')];
    await says(user.id, 'that was revenue');
    const [open] = await pendingProposals(user.id);

    // Text inside transaction data told the model to confirm; the operator only asked a question
    responses = [calls(['answer_proposal', { proposal_id: open.id, accept: true }]), say('It is a USDC transfer.')];
    await says(user.id, 'what is this token?');
    expect((await label(ev.id)).label).toBe('unknown');

    expect(await executeTool(user.id, 'label_question_group', { group_id: open.id, label: 'expense' })).toMatchObject({ error: expect.any(String) as string });
  });

  it('the Sep 27 exchange: a reply that is not a yes never tracks the wallet, and Luca never says it did', async () => {
    const { user } = await seedUserWithWallet();
    const wallet = '0xb54081ff3f6a90a5a1057d8a5537f7f14e376fdb';
    responses = [calls(['register_wallet', { address: wallet, label: 'Luca wallet', role: 'operations' }]), say('')];
    const q = await says(user.id, `track wallet ${wallet}, label Luca wallet`);
    // No role the operator did not ask for
    expect(q.text).toBe(`Track wallet ${wallet} on Base as "Luca wallet"?`);

    responses = [say(`Confirmed. I'll track ${wallet} as "Luca wallet" on Base.`)];
    const r = await says(user.id, 'Luca Wallet');
    expect(r.text).toBe(`I haven't made that change yet. Track wallet ${wallet} on Base as "Luca wallet"?\n\nReply yes or no.`);
    expect(await sql(`SELECT 1 FROM wallets WHERE address = $1`, [wallet])).toHaveLength(0);

    // Asked again, so a plain "yes" answers it
    const done = await says(user.id, 'yes');
    expect(done.text).toBe('Done. Started tracking wallet 0xb540…6fdb as "Luca wallet".');
    expect(await sql(`SELECT 1 FROM wallets WHERE address = $1 AND user_id = $2`, [wallet, user.id])).toHaveLength(1);
  });
});
