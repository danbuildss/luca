import { describe, it, expect, vi, beforeEach } from 'vitest';

// The agent loop with the model, database and prompt stubbed out: which tools the model
// is offered, and what happens when it calls an admin tool anyway.
vi.hoisted(() => { process.env.AGENT_MODEL = 'gpt-4o'; });
const create = vi.fn();
vi.mock('openai', () => ({
  default: class { chat = { completions: { create } }; },
}));
vi.mock('../../src/config.js', () => ({ config: { OPENAI_API_KEY: 'test', LOG_LEVEL: 'silent' } }));
vi.mock('../../src/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock('../../src/agent/system.js', () => ({ buildSystemPrompt: vi.fn(() => Promise.resolve('system')) }));
vi.mock('../../src/agent/context.js', () => ({
  loadConversationHistory: vi.fn(() => Promise.resolve([])),
  saveMessage: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/agent/traces.js', () => ({ saveAnswerTrace: vi.fn(() => Promise.resolve()) }));
vi.mock('../../src/ops/metrics.js', () => ({
  getInviteStats: vi.fn(() => Promise.resolve({ invited: 4, pending: 1, joined: 1, activated: 1, revoked: 1, not_activated: [] })),
  getUserStats: vi.fn(),
  getWalletHealth: vi.fn(),
  getAiCost: vi.fn(),
}));

import * as db from '../../src/db.js';
import { runAgent } from '../../src/agent/run.js';
import { ADMIN_TOOL_DEFINITIONS } from '../../src/agent/admin-tools.js';

const mockQuery = db.query as ReturnType<typeof vi.fn>;
const USER = '00000000-0000-0000-0000-000000000001';

type Request = { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> };
const request = (call: number): Request => (create.mock.calls as Request[][])[call][0];
const toolNames = (call: number): string[] => request(call).tools.map((t) => t.function.name);
// What the model was told an admin tool returned
function toolResult(): unknown {
  const msg = request(1).messages.find((m) => m.role === 'tool');
  return (JSON.parse(msg?.content ?? '{}') as { untrusted_data?: unknown }).untrusted_data;
}

function answer(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

function callTool(name: string) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: '{}' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

// Role lookups answer with `role`; everything else (spend log inserts) returns nothing
function dbRole(role: string) {
  mockQuery.mockImplementation((text: string) =>
    Promise.resolve(text.includes('FROM users WHERE id') ? { rows: [{ role }] } : { rows: [] }));
}

describe('admin tools in the agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('are not offered to an operator', async () => {
    dbRole('operator');
    create.mockResolvedValueOnce(answer('ok'));
    await runAgent({ userId: USER, userMessage: 'how many invites are pending?', role: 'operator' });
    expect(toolNames(0).some((n) => n.startsWith('admin_'))).toBe(false);
  });

  it('are offered to an admin', async () => {
    dbRole('admin');
    create.mockResolvedValueOnce(answer('ok'));
    await runAgent({ userId: USER, userMessage: 'how many invites are pending?', role: 'admin' });
    for (const t of ADMIN_TOOL_DEFINITIONS) {
      expect(toolNames(0)).toContain(t.type === 'function' ? t.function.name : '');
    }
  });

  it('refuses an admin tool call from someone whose database role is operator, even if the model asks', async () => {
    dbRole('operator');
    create.mockResolvedValueOnce(callTool('admin_get_invite_stats')).mockResolvedValueOnce(answer('not available'));
    await runAgent({ userId: USER, userMessage: 'invites?', role: 'admin' });
    expect(toolResult()).toEqual({ error: 'Not available.' });
  });

  it('answers an admin from the same metrics /ops uses', async () => {
    dbRole('admin');
    create.mockResolvedValueOnce(callTool('admin_get_invite_stats')).mockResolvedValueOnce(answer('1 pending'));
    await runAgent({ userId: USER, userMessage: 'invites?', role: 'admin' });
    expect(toolResult()).toMatchObject({ invited: 4, pending: 1 });
  });

  it('logs each model call as agent spend', async () => {
    dbRole('operator');
    create.mockResolvedValueOnce(answer('ok'));
    await runAgent({ userId: USER, userMessage: 'hi', role: 'operator' });
    const spend = mockQuery.mock.calls.filter(([text]) => String(text).includes('INSERT INTO llm_spend_log'));
    expect(spend).toHaveLength(1);
    expect(spend[0][1]).toEqual([USER, 'gpt-4o', 10, 5, (10 * 2.5 + 5 * 10) / 1_000_000]);
  });
});
