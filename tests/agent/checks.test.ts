import { describe, it, expect, vi, beforeEach } from 'vitest';

// The agent loop with a scripted model: which range a books check gets, and what happens
// when the model claims a check it never started.
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
import { namesPeriod, checkArgs, claimsCheck, CLAIM_CORRECTION, NO_CHECK_STARTED } from '../../src/agent/checks.js';

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

describe('books checks through the agent', () => {
  beforeEach(() => { vi.clearAllMocks(); seen.length = 0; });

  it('"are my books complete?" checks everything, even when the model asks for one day', async () => {
    script(callCheck({ days: 1 }), say('Checking now; I will message you when done.'));
    await runAgent({ userId: USER, userMessage: 'are my books complete?', role: 'operator' });
    expect(requestAudit).toHaveBeenCalledTimes(1);
    expect(daysAsked()).toBeNull();
  });

  it('"did you catch everything yesterday?" checks one day', async () => {
    script(callCheck({ days: 1 }), say('Checking yesterday now.'));
    await runAgent({ userId: USER, userMessage: 'did you catch everything yesterday?', role: 'operator' });
    expect(daysAsked()).toBe(1);
  });

  it('a reply claiming a check that was never started is not sent; the check is started first', async () => {
    script(
      say(CLAIM),          // claims, no tool call
      callCheck({}),       // after the correction: starts it
      say(CLAIM),          // now true
    );
    const r = await runAgent({ userId: USER, userMessage: "check everything you've tracked across my wallets", role: 'operator' });

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
    const r = await runAgent({ userId: USER, userMessage: 'check everything', role: 'operator' });
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
