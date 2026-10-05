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
  return { ...orig, config: { ...orig.config, OPENAI_API_KEY: 'test', ALCHEMY_API_KEY: 'test' } };
});
// The balance reading taken when tracking starts (src/ingestion/snapshot.ts)
const chain = vi.hoisted(() => ({ fail: false }));
vi.mock('../../src/ingestion/alchemy.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEthBalance: vi.fn(() => (chain.fail ? Promise.reject(new Error('rpc down')) : Promise.resolve(0.25))),
  getErc20Balance: vi.fn(() => (chain.fail ? Promise.reject(new Error('rpc down')) : Promise.resolve(40))),
}));
vi.mock('../../src/agent/system.js', () => ({ buildSystemPrompt: vi.fn(() => Promise.resolve('system')) }));
vi.mock('../../src/ingestion/price.js', () => ({
  getSpotPrices: vi.fn(() => Promise.resolve({ ETH: 4000, BNKR: 0.001 })),
  enrichUsdValue: vi.fn(),
}));

import { describeDb, useIntegrationDb, seedUserWithWallet, insertClassifiedEvent, insertCounterpartyRule, insertEvent, sql, addr } from './helpers/db.js';
import { runAgent } from '../../src/agent/run.js';
import { executeTool } from '../../src/agent/tools.js';
import { pendingProposals } from '../../src/corrections/proposals.js';
import { refreshQuestionGroups, getQuestionsToSend, markQuestionSent } from '../../src/alerts/questions.js';
import { askItem, askText } from '../../src/alerts/ask.js';
import { namesFor } from '../../src/books/names.js';
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
  beforeEach(() => { create.mockClear(); responses = []; chain.fail = false; });

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

  it('Sep 30: one answer about the 49.79 USDC; the model narrates "I\'m treating" both transfers. Only Luca\'s one question is sent', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const asked = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: '0x8f10000000000000000000000000000000000001', amount: 49.79, usdValue: 49.79, label: 'unknown' });
    const other = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: '0x20f6000000000000000000000000000000000002', amount: 56.65, usdValue: 56.65, label: 'unknown' });
    responses = [
      calls(['apply_correction', { event_id: asked.id, new_label: 'revenue' }]),
      say("I'm treating the 49.79 USDC from 0x8f10…0001 as revenue. I'm treating the 56.65 USDC from 0x20f6…0002 as revenue."),
    ];
    const r = await says(user.id, 'Rev from token sales');
    expect(r.text).toMatch(/^Label the 49\.79 USDC you received on .+ as revenue\?$/);
    expect(r.text).not.toMatch(/treating|56\.65/);
    expect(await sql(`SELECT 1 FROM label_proposals WHERE user_id = $1 AND status = 'pending'`, [user.id])).toHaveLength(1);
    expect((await label(asked.id)).label).toBe('unknown');
    expect((await label(other.id)).label).toBe('unknown');
  });

  it('Oct 5: "what still needs context?" is Luca\'s own numbered list, with dollars and names; dust left out; the model\'s words never sent', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'Europe/London' });
    const vendor = addr();
    await insertCounterpartyRule({ userId: user.id, address: vendor, label: 'expense', name: 'OpenAI', direction: 'in' });
    const usdc = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 35, usdValue: 35, label: 'unknown', at: '1 hour' });
    const eth = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: vendor, asset: 'ETH', amount: 0.01426, usdValue: 35.2, label: 'unknown', at: '2 hours' });
    const bnkr = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), asset: 'BNKR', amount: 70730.596728, usdValue: 30.03, label: 'unknown', at: '1 day' });
    await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), asset: 'ETH', amount: 0.0000134646, usdValue: 0.05, label: 'unknown', at: '3 hours' }); // dust

    responses = [calls(['get_unknown_transactions', {}]), say('The two ETH inflows are the main ones that still need a reason.')];
    const r = await says(user.id, 'what still needs context?');
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('3 transfers still need context:');
    expect(lines[1]).toMatch(/^1\. \w{3} \d+: 35 USDC to 0x\w{4}…\w{4} \[/);
    expect(lines[1]).toContain(usdc.hash);
    expect(lines[2]).toMatch(/^2\. \w{3} \d+: 0\.01426 ETH \(\$35\.20\) from OpenAI \[/);
    expect(lines[2]).toContain(eth.hash);
    expect(lines[3]).toMatch(/^3\. \w{3} \d+: 70,731 BNKR \(\$30\.03\) to 0x/);
    expect(lines[3]).toContain(bnkr.hash);
    expect(lines.slice(4)).toEqual(['', 'Tell me what they were, like "1 was a swap, 2 was revenue".']);
    expect(r.text).not.toMatch(/main ones|0\.0000134/);
  });

  it('Oct 5 20:07: asked again, the list is read from the books, never repeated from the chat by the model', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 35, usdValue: 35, label: 'unknown' });
    await saveMessage({ userId: user.id, role: 'assistant', content: 'These 8 still need context: … The two ETH inflows are the main ones.' });
    responses = [say('These 8 still need context: … The two ETH inflows are still the main ones.')];
    create.mockClear();

    const r = await says(user.id, 'what still needs context?');
    expect(create).not.toHaveBeenCalled();
    expect(r.text.split('\n')[0]).toBe('1 transfer still needs context:');
    expect(r.text).not.toContain('main ones');
  });

  it('Oct 5 21:35: Dan answers the list by number; Luca asks once in its own words, and "yes" labels exactly those', async () => {
    const { user, wallet } = await seedUserWithWallet({ timezone: 'Europe/London' });
    const exchange = addr();
    const f8 = '0x8f10000000000000000000000000000000f99600';
    const wrongRule = await insertCounterpartyRule({ userId: user.id, address: f8, label: 'expense', direction: 'in' });
    // Newest first, as the list shows them
    const ev = [
      await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 35, usdValue: 35, label: 'unknown', at: '1 hour' }),
      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), asset: 'ETH', amount: 0.01426, usdValue: 38.79, label: 'unknown', at: '2 hours' }),
      await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), asset: 'BNKR', amount: 70730.6, usdValue: 30.11, label: 'unknown', at: '1 day' }),
      await insertClassifiedEvent({ wallet, direction: 'out', counterparty: exchange, amount: 106.88, usdValue: 106.88, label: 'unknown', at: '5 days' }),
      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: f8, amount: 49.79, usdValue: 49.79, label: 'unknown', at: '5 days 1 hour' }),
      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), amount: 56.65, usdValue: 56.65, label: 'unknown', at: '5 days 2 hours' }),
      await insertClassifiedEvent({ wallet, direction: 'out', counterparty: exchange, asset: 'ETH', amount: 0.03303, usdValue: 89.54, label: 'unknown', at: '6 days' }),
      await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), asset: 'ETH', amount: 0.0015, usdValue: 4.06, label: 'unknown', at: '8 days' }),
    ];
    expect((await says(user.id, 'what still needs context?')).text.split('\n')[0]).toBe('8 transfers still need context:');

    create.mockClear();
    const q = await says(user.id, '1 was an expense, 2 was an internal transfer, 3 was a swap, 4 and 7 were swaps, 5 and 6 were swaps, not sure about 8');
    expect(create).not.toHaveBeenCalled();
    const lines = q.text.split('\n');
    expect(lines.slice(0, 3)).toEqual(["I'll leave 8 as it is for now.", '', 'Make these 7 changes?']);
    expect(lines[3]).toMatch(/^1\. Label the 35 USDC you sent on .+ as expense$/);
    expect(lines[4]).toMatch(/^2\. Label the 0\.01426 ETH you received on .+ as internal transfer$/);
    expect(lines.at(-1)).toBe('Reply yes or no.');
    for (const e of ev) expect((await label(e.id)).label).toBe('unknown');

    const done = await says(user.id, 'yes');
    expect(create).not.toHaveBeenCalled();
    expect(done.text).toMatch(/^Done:\n/);
    expect(done.text).not.toMatch(/earlier payment/);
    expect(done.text.match(/New transfers with this address will be labeled the same way\./g) ?? []).toHaveLength(1);
    expect((await Promise.all(ev.map((e) => label(e.id)))).map((l) => l.label))
      .toEqual(['expense', 'internal_transfer', 'swap', 'swap', 'swap', 'swap', 'swap', 'unknown']);
    // The wrong incoming-expense rule for 0x8f10 is switched off by the answer to 5
    expect((await sql<{ active: boolean }>(`SELECT active FROM counterparty_rules WHERE id = $1`, [wrongRule]))[0].active).toBe(false);
    // The operator's own words are kept with each correction
    expect(await sql(`SELECT 1 FROM corrections WHERE user_id = $1 AND source_message LIKE '1 was an expense%'`, [user.id])).toHaveLength(7);
  });

  it('a numbered answer to the morning message\'s list labels those groups after one yes', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const a = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 106.88, usdValue: 106.88, label: 'unknown', at: '2 days' });
    const b = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), amount: 56.65, usdValue: 56.65, label: 'unknown', at: '2 days' });
    await refreshQuestionGroups(user.id);
    const groups = await getQuestionsToSend(user.id);
    for (const [i, g] of groups.entries()) await markQuestionSent(g.id, 77, i + 1);
    await saveMessage({ userId: user.id, role: 'assistant', content: askText(groups, await namesFor(user.id), (d) => new Date(d).toISOString().slice(0, 10)) });

    create.mockClear();
    const q = await says(user.id, '1 was a swap, 2 was revenue');
    expect(create).not.toHaveBeenCalled();
    expect(q.text).toMatch(/^Make these 2 changes\?\n1\. Label the USDC payment to .+\$106\.88\) as swap\n2\. Label the USDC transfer from .+\$56\.65\) as revenue/);
    await says(user.id, 'yes');
    expect((await label(a.id)).label).toBe('swap');
    expect((await label(b.id)).label).toBe('revenue');
  });

  it('a number that is not in the last list changes nothing', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const only = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 35, usdValue: 35, label: 'unknown' });
    await says(user.id, 'what still needs context?');
    create.mockClear();
    const r = await says(user.id, '1 was an expense, 2 was a swap');
    expect(create).not.toHaveBeenCalled();
    expect(r.text).toBe('My last list has no number 2, so I haven\'t changed anything. Ask "what still needs context?" for a fresh list.');
    expect((await label(only.id)).label).toBe('unknown');
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
    expect(done.text).toMatch(/^I made 2 of the 3 changes:\n- Labeled the 12 USDC you received on .+ as revenue\n- I'm reading 0x\w{4}…\w{4} on Base as "ops"\n\nNot made:\n- Label the 5 USDC you sent on .+ as expense: I could not find that transaction in your books any more/);
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
    const name = await namesFor(user.id);
    const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
    expect(askItem(g, name, day)).toMatch(/^4 USDC payments to 0x\w{4}…\w{4} \(\$1,240\.00 total\), .+$/);
    await markQuestionSent(g.id, 1);
    await saveMessage({ userId: user.id, role: 'assistant', content: askText([g], name, day) });

    responses = [calls(['label_question_group', { group_id: g.id, label: 'expense' }]), say('Got it.')];
    const q = await says(user.id, 'those are infrastructure costs');
    expect(q.text).toMatch(/^Got it\.\n\nLabel those 4 USDC payments to 0x\w{4}…\w{4} \(.+ to .+, \$1,240\.00 total\) as expense\?$/);
    for (const e of evs) expect((await label(e.id)).label).toBe('unknown');

    const done = await says(user.id, 'yes');
    expect(done.text).toMatch(/^Done\. Labeled those 4 USDC payments to .+ as expense\. New transfers with this address will be labeled the same way\.$/);
    for (const e of evs) expect(await label(e.id)).toEqual({ label: 'expense', source: 'user' });
  });

  it('"1 was a swap, 2 was revenue" answers items 1 and 2 of the morning list: one question, nothing changed before yes', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const a = await insertClassifiedEvent({ wallet, direction: 'out', counterparty: addr(), amount: 106.88, usdValue: 106.88, label: 'unknown', at: '3 days' });
    const b = await insertClassifiedEvent({ wallet, direction: 'in', counterparty: addr(), amount: 49.79, usdValue: 49.79, label: 'unknown', at: '2 days' });
    await refreshQuestionGroups(user.id);
    const [g1, g2] = await getQuestionsToSend(user.id);
    await markQuestionSent(g1.id, 9, 1);
    await markQuestionSent(g2.id, 9, 2);

    responses = [calls(['label_question_group', { group_id: g1.id, label: 'swap' }], ['label_question_group', { group_id: g2.id, label: 'revenue' }]), say('')];
    const r = await says(user.id, '1 was a swap, 2 was revenue');
    expect(r.text).toMatch(/^Make these 2 changes\?\n/);
    expect((await label(a.id)).label).toBe('unknown');
    expect((await label(b.id)).label).toBe('unknown');

    await says(user.id, 'yes');
    expect((await label(a.id)).label).toBe('swap');
    expect((await label(b.id)).label).toBe('revenue');
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
    responses = [calls(['apply_correction', { event_id: latest.id, new_label: 'refund' }]), say('')];
    await says(user.id, 'the 20 USDC payment was refund');

    const done = await says(user.id, 'yes');
    expect(done.text).toMatch(/^Done\. Labeled the 20 USDC you sent on .+ as refund\. New transfers with this address will be labeled the same way\. I haven't changed any earlier ones\.\n\nI found 1 earlier payment to .+ Want me to label it refund too\?/);
    expect((await label(earlier.id)).label).toBe('expense');

    const again = await says(user.id, 'yes');
    expect(again.text).toMatch(/^Done\. 1 earlier payment to .+ is now refund\.$/);
    expect((await label(earlier.id)).label).toBe('refund');
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
    expect(done.text).toBe(`Done. I'm reading 0xb540…6fdb on Base as "Luca wallet". I can already see 0.25 ETH, 40 USDC and 40 BNKR. I'll message you when your books are ready.`);
    expect(await sql(`SELECT 1 FROM wallets WHERE address = $1 AND user_id = $2`, [wallet, user.id])).toHaveLength(1);
  });

  it('the model copying the question, with a role nobody asked for, never reaches the operator (Sep 27)', async () => {
    const { user } = await seedUserWithWallet();
    const wallet = '0x042455f9990098e11592be1fbd72e6dc68419b13';
    responses = [
      calls(['register_wallet', { address: wallet, label: 'Test', chain: 'base' }]),
      say(`Track wallet ${wallet} on Base as "Test" (operations)?`),
    ];
    const q = await says(user.id, `track wallet ${wallet} label Test`);
    expect(q.text).toBe(`Track wallet ${wallet} on Base as "Test"?`);
    expect(await sql(`SELECT 1 FROM wallets WHERE address = $1`, [wallet])).toHaveLength(0);
  });

  it('the Sep 28 new operator: a balance question right after "yes" finds the balances, and says the books are not ready yet', async () => {
    const { user } = await seedUserWithWallet();
    const wallet = '0x9a958557d906f10aca9ed0a8509cf9366059e511';
    responses = [calls(['register_wallet', { address: wallet }]), say('')];
    await says(user.id, wallet);
    await says(user.id, 'Yes');

    const cash = await executeTool(user.id, 'get_cash_position', {}) as {
      balances: Array<{ address: string; asset: string; balance: number }>;
      wallets: Array<{ address: string; books_ready: boolean; balances_read: boolean }>;
    };
    expect(cash.balances.filter((b) => b.address === wallet).map((b) => [b.asset, b.balance]).sort())
      .toEqual([['BNKR', 40], ['ETH', 0.25], ['USDC', 40]]);
    expect(cash.wallets.find((w) => w.address === wallet)).toMatchObject({ books_ready: false, balances_read: true });
    // The operator's first wallet (established) is not affected
    expect(cash.wallets.filter((w) => w.address !== wallet).map((w) => w.books_ready)).toEqual([true]);
  });

  it('a failed balance reading never stops tracking; the first sync takes the balances', async () => {
    const { user } = await seedUserWithWallet();
    const wallet = '0x9a958557d906f10aca9ed0a8509cf9366059e511';
    chain.fail = true;
    responses = [calls(['register_wallet', { address: wallet }]), say('')];
    await says(user.id, wallet);
    const done = await says(user.id, 'yes');

    expect(done.text).toBe(`Done. I'm reading 0x9a95…e511 on Base. I'll message you when your books are ready.`);
    expect(await sql(`SELECT 1 FROM wallets w JOIN watch_jobs wj ON wj.wallet_id = w.id WHERE w.address = $1 AND w.user_id = $2 AND wj.status = 'active'`, [wallet, user.id])).toHaveLength(1);
    expect(await sql(`SELECT 1 FROM balance_snapshots bs JOIN wallets w ON w.id = bs.wallet_id WHERE w.address = $1`, [wallet])).toHaveLength(0);
  });
});
