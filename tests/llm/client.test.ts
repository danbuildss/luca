import { beforeEach, describe, expect, it, vi } from 'vitest';

// The classifier uses the chat agent's LLM provider (src/llm/client.ts)

const cfg = vi.hoisted((): Record<string, unknown> => ({
  LOG_LEVEL: 'silent',
  AGENT_MODEL: 'gpt-4o',
  LLM_DAILY_SPEND_CAP_USD: 1,
}));
vi.mock('../../src/config.js', () => ({ config: cfg }));

const { query, ctor, create } = vi.hoisted(() => ({
  query: vi.fn(),
  ctor: vi.fn(),
  create: vi.fn<(req: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock('../../src/db.js', () => ({ query, pool: { connect: vi.fn() } }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
    constructor(opts: unknown) { ctor(opts); }
  },
}));

import { classifyWithLlmDetailed, isPermanentApiError } from '../../src/classification/llm.js';
import { classifierModel, llmCallCost, llmClientOptions } from '../../src/llm/client.js';
import type { UnclassifiedEvent } from '../../src/classification/types.js';

const event = { id: 'ev-1', direction: 'out', asset: 'BNKR', amount: 700000, from_address: '0xa', to_address: '0xb', block_time: new Date('2026-09-28T00:00:00Z') } as unknown as UnclassifiedEvent;

let spendToday = '0';
let logged: unknown[][] = [];

beforeEach(() => {
  for (const k of ['OPENAI_API_KEY', 'AGENT_LLM_KEY', 'AGENT_BASE_URL', 'CLASSIFIER_MODEL']) delete cfg[k];
  cfg.AGENT_MODEL = 'gpt-4o';
  spendToday = '0';
  logged = [];
  ctor.mockReset();
  create.mockReset();
  create.mockResolvedValue({
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
    choices: [{ finish_reason: 'stop', message: { content: '{"results":[{"id":"ev-1","label":"treasury","confidence":0.8,"evidence":"Sent to a staking contract."}]}' } }],
  });
  query.mockReset();
  query.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO llm_spend_log')) logged.push(params ?? []);
    return Promise.resolve({ rows: [{ total: spendToday }] });
  });
});

describe('llmClientOptions', () => {
  it('uses the gateway key and endpoint, with the X-API-Key header', () => {
    cfg.AGENT_LLM_KEY = 'gw-key';
    cfg.AGENT_BASE_URL = 'https://llm.example/v1';
    cfg.OPENAI_API_KEY = 'oa-key';
    expect(llmClientOptions({ timeout: 5 })).toEqual({
      apiKey: 'gw-key', timeout: 5, baseURL: 'https://llm.example/v1', defaultHeaders: { 'X-API-Key': 'gw-key' },
    });
  });

  it('falls back to OPENAI_API_KEY on OpenAI, and to nothing without a key', () => {
    cfg.OPENAI_API_KEY = 'oa-key';
    expect(llmClientOptions()).toEqual({ apiKey: 'oa-key' });
    delete cfg.OPENAI_API_KEY;
    expect(llmClientOptions()).toBeNull();
  });
});

describe('classifierModel', () => {
  it('is the agent model on a gateway, gpt-4o-mini on OpenAI, CLASSIFIER_MODEL when set', () => {
    expect(classifierModel()).toBe('gpt-4o-mini');
    cfg.AGENT_BASE_URL = 'https://llm.example/v1';
    cfg.AGENT_MODEL = 'gpt-5.4-mini';
    expect(classifierModel()).toBe('gpt-5.4-mini');
    cfg.CLASSIFIER_MODEL = 'cheap-model';
    expect(classifierModel()).toBe('cheap-model');
  });
});

describe('classifyWithLlmDetailed', () => {
  it('classifies through the gateway when only the agent key is set', async () => {
    cfg.AGENT_LLM_KEY = 'gw-key';
    cfg.AGENT_BASE_URL = 'https://llm.example/v1';
    cfg.AGENT_MODEL = 'gpt-5.4-mini';

    const { results, failures } = await classifyWithLlmDetailed([event], 'user-1');

    expect(failures.size).toBe(0);
    expect(results.get('ev-1')?.label).toBe('treasury');
    expect(ctor).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'gw-key', baseURL: 'https://llm.example/v1', defaultHeaders: { 'X-API-Key': 'gw-key' }, timeout: 60_000, maxRetries: 1,
    }));
    const req = create.mock.calls[0][0];
    expect(req.model).toBe('gpt-5.4-mini');
    expect(req).not.toHaveProperty('response_format');
    expect(req).not.toHaveProperty('max_tokens');
    // Unpriced model: logged at $0 so the cost figures list it as unpriced
    expect(logged).toEqual([['user-1', 'gpt-5.4-mini', 1000, 200, 0]]);
  });

  it('uses gpt-4o-mini in JSON mode on OpenAI, priced', async () => {
    cfg.OPENAI_API_KEY = 'oa-key';

    await classifyWithLlmDetailed([event], 'user-1');

    expect(ctor).toHaveBeenCalledWith({ apiKey: 'oa-key', timeout: 60_000, maxRetries: 1 });
    const req = create.mock.calls[0][0];
    expect(req.model).toBe('gpt-4o-mini');
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(logged[0][4]).toBeCloseTo(llmCallCost('gpt-4o-mini', 1000, 200));
  });

  it('leaves events waiting, uncounted, when no key is set', async () => {
    const { results, failures } = await classifyWithLlmDetailed([event], 'user-1');
    expect(results.size).toBe(0);
    expect(failures.get('ev-1')).toEqual({ countsAsAttempt: false, reason: 'No rule matched and LLM unavailable (no API key)' });
    expect(ctor).not.toHaveBeenCalled();
  });

  it('stops at the daily cap, counting unpriced classification tokens at the dearest price', async () => {
    cfg.AGENT_LLM_KEY = 'gw-key';
    cfg.AGENT_BASE_URL = 'https://llm.example/v1';
    spendToday = '1.5';

    const { failures } = await classifyWithLlmDetailed([event], 'user-1');

    expect(create).not.toHaveBeenCalled();
    expect(failures.get('ev-1')).toEqual({ countsAsAttempt: false, reason: 'No rule matched and LLM daily spend cap reached' });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("purpose = 'classification' AND cost_usd = 0");
    expect(params).toEqual([2.5, 10]);
  });

  it('does not use up attempts when the provider rejects the key or the model', async () => {
    cfg.AGENT_LLM_KEY = 'gw-key';
    cfg.AGENT_BASE_URL = 'https://llm.example/v1';
    create.mockRejectedValue(Object.assign(new Error('model not found'), { status: 404 }));

    const { failures } = await classifyWithLlmDetailed([event], 'user-1');

    expect(failures.get('ev-1')).toEqual({ countsAsAttempt: false, reason: 'LLM request failed' });
  });
});

describe('isPermanentApiError', () => {
  it('counts a bad request, not the key, the model, rate limits or server errors', () => {
    expect(isPermanentApiError({ status: 400 })).toBe(true);
    expect(isPermanentApiError({ status: 422 })).toBe(true);
    for (const status of [401, 403, 404, 429, 500, 503]) expect(isPermanentApiError({ status })).toBe(false);
    expect(isPermanentApiError(new Error('network'))).toBe(false);
  });
});
