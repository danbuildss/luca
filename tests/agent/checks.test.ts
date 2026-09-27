import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// The agent loop with a scripted model: completeness questions answered by a check without
// the model, which range a check gets, and what happens when the model claims a check it
// never started or states a verdict no check backs.
vi.hoisted(() => { process.env.AGENT_MODEL = 'gpt-4o'; });
// Each request as the model saw it (the loop keeps appending to the same array)
const seen: Array<{ tool_choice: unknown; messages: Array<{ role: string; content: string | null }> }> = [];
const create = vi.fn((req: unknown) => {
  seen.push(JSON.parse(JSON.stringify(req)) as (typeof seen)[number]);
  return next();
});
let next: () => unknown = () => { throw new Error('no scripted response'); };
function script(...responses: unknown[]) {
  next = () => Promise.resolve(responses.shift());
}
vi.mock('openai', () => ({
  default: class { chat = { completions: { create } }; },
}));
vi.mock('../../src/config.js', () => ({ config: { OPENAI_API_KEY: 'test', LOG_LEVEL: 'silent' } }));
vi.mock('../../src/db.js', () => ({ query: vi.fn(() => Promise.resolve({ rows: [] })), pool: { connect: vi.fn() } }));
vi.mock('../../src/agent/system.js', () => ({ buildSystemPrompt: vi.fn(() => Promise.resolve('system')) }));
vi.mock('../../src/agent/context.js', () => ({
  loadConversationHistory: vi.fn(() => Promise.resolve([])),
  saveMessage: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/agent/traces.js', () => ({ saveAnswerTrace: vi.fn(() => Promise.resolve()) }));
const requestAudit = vi.hoisted(() => vi.fn(() => Promise.resolve({ status: 'started', run_id: 'r1', wallets: 1 })));
vi.mock('../../src/ledger/audit-runs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestAudit,
}));

import { runAgent } from '../../src/agent/run.js';
import { saveAnswerTrace } from '../../src/agent/traces.js';
import * as db from '../../src/db.js';
import {
  namesPeriod, checkArgs, activityArgs, walletArgs, restatesChange, claimsChange, NO_CHANGE_MADE, claimsCheck, claimsVerdict, asksCompleteness, periodDays, leaksToolCall,
  CLAIM_CORRECTION, NO_CHECK_STARTED, VERDICT_CORRECTION, TOOL_LEAK_CORRECTION, TOOL_LEAK_FALLBACK,
} from '../../src/agent/checks.js';

const USER = '00000000-0000-0000-0000-000000000001';
const CLAIM = "I'm checking everything I've tracked across your wallets and will message you when it's done.";


function say(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}
function callCheck(args: Record<string, unknown>) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'check_books_complete', arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}
function callTool(name: string, args: Record<string, unknown>) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't2', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}
// The exact reply an operator got in production (Sep 27)
const LEAK = '{"limit":20,"period_days":7}\n\nI’m sorry, but I can’t show recent transactions right now because I need the tool result to answer that.';
const daysAsked = (): unknown => (requestAudit.mock.calls as unknown as Array<[{ days: unknown }]>)[0][0].days;

describe('the period a books check covers', () => {
  it('recognises a named period', () => {
    for (const m of ['did you catch everything yesterday?', 'anything missing this week?', 'check the last 3 days',
      'since Monday?', 'overnight', 'past 24h', 'last month']) {
      expect(namesPeriod(m), m).toBe(true);
    }
    for (const m of ['are my books complete?', 'are you missing anything?', 'check my wallets',
      "check everything you've tracked across my wallets"]) {
      expect(namesPeriod(m), m).toBe(false);
    }
  });

  it('drops days the operator did not ask for, keeps them when they did', () => {
    expect(checkArgs('are my books complete?', { days: 1 })).toEqual({});
    expect(checkArgs('did you catch everything yesterday?', { days: 1 })).toEqual({ days: 1 });
  });
});

describe('claims of a running check', () => {
  it('recognises a reply that says a check is under way', () => {
    expect(claimsCheck(CLAIM)).toBe(true);
    expect(claimsCheck("I'm checking your wallets now.")).toBe(true);
    expect(claimsCheck('You spent $12.00 on gas this week.')).toBe(false);
  });
});

describe('recognising completeness questions and their period', () => {
  it('knows a completeness question when it sees one', () => {
    for (const m of ['are my books complete?', 'Are my books up to date?', 'are you missing anything?',
      'did you miss anything?', 'did you catch everything yesterday?', 'check my wallets',
      "check everything you've tracked across my wallets", "check @alice's books"]) {
      expect(asksCompleteness(m), m).toBe(true);
    }
    for (const m of ['how are we doing this week?', 'what did gas cost?', 'that payment was not revenue',
      'how many invites are pending?']) {
      expect(asksCompleteness(m), m).toBe(false);
    }
  });

  it('turns a named period into days, and no period into everything', () => {
    expect(periodDays('are my books complete?')).toBeNull();
    expect(periodDays('did you catch everything yesterday?')).toBe(1);
    expect(periodDays('anything missing this week?')).toBe(7);
    expect(periodDays('check the last 3 days')).toBe(3);
    expect(periodDays('missing anything in the past 2 weeks?')).toBe(14);
    // Sunday Sep 27 2026 → since Friday is 2 days
    expect(periodDays('missed anything since friday?', new Date('2026-09-27T12:00:00Z'))).toBe(2);
  });

  it('recognises a completeness verdict in a reply', () => {
    expect(claimsVerdict('Yes. Your books are complete for the wallets I track.')).toBe(true);
    expect(claimsVerdict('no missing movements were found')).toBe(true);
    expect(claimsVerdict('Revenue this week was $840.')).toBe(false);
  });
});

describe('books checks through the agent', () => {
  beforeEach(() => { vi.clearAllMocks(); seen.length = 0; });

  it('"are my books complete?" starts a full check without asking the model, in the check\'s words', async () => {
    const r = await runAgent({ userId: USER, userMessage: 'are my books complete?', role: 'operator' });
    expect(create).not.toHaveBeenCalled();
    expect(requestAudit).toHaveBeenCalledTimes(1);
    expect(daysAsked()).toBeNull();
    expect(r.text).toBe("Checking everything I've tracked across your wallet against the chain now. I'll message you with the result, usually within a few minutes.");
  });

  it('"did you catch everything yesterday?" checks one day', async () => {
    const r = await runAgent({ userId: USER, userMessage: 'did you catch everything yesterday?', role: 'operator' });
    expect(daysAsked()).toBe(1);
    expect(r.text).toMatch(/^Checking the last day across your wallet against the chain now\./);
  });

  it('a still-valid result is given as the check wrote it, never rephrased', async () => {
    requestAudit.mockResolvedValueOnce({ status: 'reused', checked_at: 'x', unchanged: true, message: 'Nothing has changed in your books since I checked at 09:12.\nI checked everything…' } as never);
    const r = await runAgent({ userId: USER, userMessage: 'are you missing anything?', role: 'operator' });
    expect(create).not.toHaveBeenCalled();
    expect(r.text).toBe('Nothing has changed in your books since I checked at 09:12.\nI checked everything…');
  });

  it('an admin asking about another operator by @username checks that operator\'s wallets', async () => {
    const mq = db.query as unknown as Mock<(text: string) => Promise<unknown>>;
    mq.mockImplementation((text: string) => Promise.resolve(
      text.includes('SELECT role') ? { rows: [{ role: 'admin' }] }
        : text.includes('telegram_username') ? { rows: [{ id: 'alice-id' }] }
          : { rows: [] }));
    const r = await runAgent({ userId: USER, userMessage: "check @alice's books", role: 'admin' });
    expect((requestAudit.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]).toMatchObject({ userId: 'alice-id', requestedBy: USER, admin: true });
    expect(r.text).toMatch(/^Checking everything I've tracked across @alice's wallet/);
    mq.mockImplementation(() => Promise.resolve({ rows: [] }));
  });

  it('an operator naming someone else only ever checks their own wallets', async () => {
    await runAgent({ userId: USER, userMessage: "check @alice's books", role: 'operator' });
    expect((requestAudit.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]).toMatchObject({ userId: USER });
  });

  it('a model reply stating a verdict with no check behind it is not sent', async () => {
    script(
      say('Yes. Your books are complete and nothing is missing. Revenue this week was $840.'),
      say('Revenue this week was $840.'),
    );
    const r = await runAgent({ userId: USER, userMessage: 'how are we doing this week?', role: 'operator' });
    expect(seen[1].messages.at(-1)).toEqual({ role: 'system', content: VERDICT_CORRECTION });
    expect(r.text).toBe('Revenue this week was $840.');
    expect(requestAudit).not.toHaveBeenCalled();
  });

  it('if the model keeps stating a verdict, a real check is started instead', async () => {
    script(say('Your books are complete.'), say('Your books are complete.'));
    const r = await runAgent({ userId: USER, userMessage: 'how are we doing this week?', role: 'operator' });
    expect(requestAudit).toHaveBeenCalledTimes(1);
    expect(daysAsked()).toBe(7);
    expect(r.text).toMatch(/^Checking the last 7 days across your wallet against the chain now\./);
  });

  it('the model asking for one day on a question with no period still checks everything', async () => {
    script(callCheck({ days: 1 }), say('Checking now; I will message you when done.'));
    await runAgent({ userId: USER, userMessage: 'can you look over my wallets for me?', role: 'operator' });
    expect(requestAudit).toHaveBeenCalledTimes(1);
    expect(daysAsked()).toBeNull();
  });

  it('a reply claiming a check that was never started is not sent; the check is started first', async () => {
    script(
      say(CLAIM),          // claims, no tool call
      callCheck({}),       // after the correction: starts it
      say(CLAIM),          // now true
    );
    const r = await runAgent({ userId: USER, userMessage: 'can you look over my wallets for me?', role: 'operator' });

    expect(requestAudit).toHaveBeenCalledTimes(1);
    expect(daysAsked()).toBeNull();
    // The correction replaced the false claim and required a tool call
    const second = seen[1];
    expect(second.tool_choice).toBe('required');
    expect(second.messages.at(-1)).toEqual({ role: 'system', content: CLAIM_CORRECTION });
    expect(second.messages.some((m) => m.role === 'assistant' && m.content === CLAIM)).toBe(false);
    expect(r.text).toBe(CLAIM);
  });

  it('if the model still does not start it, Luca says plainly that no check is running', async () => {
    script(say(CLAIM), say(CLAIM));
    const r = await runAgent({ userId: USER, userMessage: 'can you look over my wallets for me?', role: 'operator' });
    expect(requestAudit).not.toHaveBeenCalled();
    expect(r.text).toBe(NO_CHECK_STARTED);
  });

  it('an ordinary answer is sent as is, with no extra model call', async () => {
    script(say('You spent $12.00 on gas this week.'));
    const r = await runAgent({ userId: USER, userMessage: 'what did gas cost this week?', role: 'operator' });
    expect(r.text).toBe('You spent $12.00 on gas this week.');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('tool input never reaches the operator', () => {
  beforeEach(() => { vi.clearAllMocks(); seen.length = 0; });

  it('recognises raw tool input and tool talk, and nothing else', () => {
    for (const t of [LEAK, '{"limit":20,"period_days":7}', 'Here: {"hash": "0xabc"}', 'I need the tool result first.', 'Making a function call now.']) {
      expect(leaksToolCall(t), t).toBe(true);
    }
    for (const t of ['You spent $12.00 on gas this week.', 'Revenue {approx} was $840.', 'Nothing here: {}',
      '```\nRevenue      +$4,810.00\nExpenses     -$1,940.00\n```', 'A tool for the job.']) {
      expect(leaksToolCall(t), t).toBe(false);
    }
  });

  it('a reply showing tool input is not sent; the model must make the call, then answers from its result', async () => {
    script(
      say(LEAK),
      callTool('get_recent_activity', { limit: 20, period_days: 7 }),
      say('Nothing moved in your wallet this week.'),
    );
    const r = await runAgent({ userId: USER, userMessage: 'show me my recent transactions', role: 'operator' });

    expect(seen[1].tool_choice).toBe('required');
    expect(seen[1].messages.at(-1)).toEqual({ role: 'system', content: TOOL_LEAK_CORRECTION });
    expect(seen[1].messages.some((m) => m.role === 'assistant' && m.content === LEAK)).toBe(false);
    // Once the call is made, the answer may be plain text again
    expect(seen[2].tool_choice).toBe('auto');
    expect(r.text).toBe('Nothing moved in your wallet this week.');
  });

  it('if the model shows tool input again, Luca says plainly it could not look it up', async () => {
    script(say(LEAK), say('{"limit":20}'));
    const r = await runAgent({ userId: USER, userMessage: 'show me my recent transactions', role: 'operator' });
    expect(r.text).toBe(TOOL_LEAK_FALLBACK);
    expect(r.text).not.toMatch(/[{}]|tool/i);
  });
});

describe('recent transactions cover everything unless a category is named', () => {
  beforeEach(() => { vi.clearAllMocks(); seen.length = 0; });

  it('keeps a label only when the operator named that category', () => {
    expect(activityArgs('show me my recent transactions', { label: 'unknown', period_days: 7 })).toEqual({ period_days: 7 });
    expect(activityArgs('what happened this week?', { label: 'revenue' })).toEqual({});
    expect(activityArgs('show me my expenses this week', { label: 'expense' })).toEqual({ label: 'expense' });
    expect(activityArgs('anything that still needs context?', { label: 'unknown' })).toEqual({ label: 'unknown' });
    expect(activityArgs('what did I spend on gas?', { label: 'gas' })).toEqual({ label: 'gas' });
    expect(activityArgs('show me my swaps', { label: 'swap' })).toEqual({ label: 'swap' });
    expect(activityArgs('show me recent transactions', { period_days: 7 })).toEqual({ period_days: 7 });
  });

  it('the Sep 27 case: the model asks for unknowns only, the tool runs without the filter', async () => {
    script(
      callTool('get_recent_activity', { label: 'unknown', limit: 20, period_days: 7 }),
      say('All 2 transactions in the last 7 days: ...'),
    );
    await runAgent({ userId: USER, userMessage: 'show me my recent transactions', role: 'operator' });
    const trace = (saveAnswerTrace as unknown as Mock).mock.calls[0][0] as { tools: Array<{ name: string; args: Record<string, unknown> }> };
    expect(trace.tools).toEqual([{ name: 'get_recent_activity', args: { limit: 20, period_days: 7 } }]);
  });
});

describe('a change is asked about in Luca\'s words, not the model\'s', () => {
  it('recognises model text that talks about the change itself', () => {
    for (const t of ['Done! I have labeled it as revenue.', "I'll label that as revenue for you.", 'Should I label it as revenue?',
      'It is now labeled revenue.', 'Please confirm below.', 'Tap Confirm to apply.', "I've started tracking that wallet."]) {
      expect(restatesChange(t), t).toBe(true);
    }
    for (const t of ['You paid $0.01 in network fees this week.', 'Revenue this week was $840.', '']) {
      expect(restatesChange(t), t).toBe(false);
    }
  });
});

describe('Luca never says a change happened unless it did', () => {
  beforeEach(() => { vi.clearAllMocks(); seen.length = 0; });

  it('recognises a claim that a change was made, and nothing else', () => {
    for (const t of ['Confirmed. I\'ll track 0xb54081ff3f6a90a5a1057d8a5537f7f14e376fdb as "Luca wallet" on Base.', 'Done! I\'ve labeled it revenue.',
      "I've started tracking it.", 'It is now labeled revenue.', "I'm now tracking that wallet.", 'Got it. Done.']) {
      expect(claimsChange(t), t).toBe(true);
    }
    for (const t of ['The gas total is small and fully confirmed.', "Tell me what it was and I'll label it.",
      'That payment has been labeled revenue since Sep 3.', "I'm tracking 2 wallets for you.", "You've done 3 swaps this week.",
      "I checked everything I've tracked across your wallets.", "I've recorded 14 transactions since Aug 27."]) {
      expect(claimsChange(t), t).toBe(false);
    }
  });

  it('a claimed change with nothing made and nothing waiting is replaced', async () => {
    script(say('Confirmed. I\'ll track 0xb54081ff3f6a90a5a1057d8a5537f7f14e376fdb on Base.'));
    const r = await runAgent({ userId: USER, userMessage: 'Luca Wallet', role: 'operator' });
    expect(r.text).toBe(NO_CHANGE_MADE);
  });

  it('keeps a wallet role only when the operator named one', () => {
    const args = { address: '0xabc', label: 'Luca wallet', role: 'operations' };
    expect(walletArgs('track wallet 0xabc, label Luca wallet', args)).toEqual({ address: '0xabc', label: 'Luca wallet' });
    expect(walletArgs('track my ops wallet 0xabc', args)).toEqual(args);
    expect(walletArgs('track my treasury wallet 0xabc', { address: '0xabc', role: 'treasury' })).toEqual({ address: '0xabc', role: 'treasury' });
  });
});
