import { describe, it, expect, vi } from 'vitest';

// The quality report is fixed wording: the admin gets it exactly as written, never the
// model's paraphrase of it.
vi.hoisted(() => { process.env.AGENT_MODEL = 'gpt-4o'; });
const responses: unknown[] = [];
vi.mock('openai', () => ({
  default: class { chat = { completions: { create: () => Promise.resolve(responses.shift()) } }; },
}));
vi.mock('../../src/config.js', () => ({ config: { OPENAI_API_KEY: 'test', LOG_LEVEL: 'silent' } }));
vi.mock('../../src/db.js', () => ({ query: vi.fn(() => Promise.resolve({ rows: [] })), pool: { connect: vi.fn() } }));
vi.mock('../../src/agent/system.js', () => ({ buildSystemPrompt: vi.fn(() => Promise.resolve('system')) }));
vi.mock('../../src/agent/context.js', () => ({
  loadConversationHistory: vi.fn(() => Promise.resolve([])),
  saveMessage: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/agent/traces.js', () => ({ saveAnswerTrace: vi.fn(() => Promise.resolve()) }));
vi.mock('../../src/agent/admin-tools.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeAdminTool: vi.fn(() => Promise.resolve({ report: 'Classification quality: all operators\n\n(the report)' })),
}));

import { runAgent } from '../../src/agent/run.js';

describe('the admin quality question', () => {
  it('is answered with the report exactly as written', async () => {
    responses.push(
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'q', type: 'function', function: { name: 'admin_get_classification_quality', arguments: '{}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [{ message: { role: 'assistant', content: 'Luca is 95% accurate!' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    );
    const r = await runAgent({ userId: '00000000-0000-0000-0000-000000000001', userMessage: 'how accurate is Luca?', role: 'admin' });
    expect(r.text).toBe('Classification quality: all operators\n\n(the report)');
  });
});
