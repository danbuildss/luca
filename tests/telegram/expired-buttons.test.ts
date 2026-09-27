import { describe, it, expect, vi } from 'vitest';

// Operators answer Luca in chat. A button still on screen from before (Confirm / Cancel,
// labels on Luca's questions and alerts) says it has expired and changes nothing.
const query = vi.hoisted(() => vi.fn(() => Promise.resolve({ rows: [] })));
vi.mock('../../src/db.js', () => ({ query, pool: { connect: vi.fn() } }));
vi.mock('../../src/config.js', () => ({ config: { LOG_LEVEL: 'silent' } }));

import { handleCallback, EXPIRED_BUTTON_REPLY } from '../../src/telegram/callbacks.js';
import type { Context } from 'telegraf';

function ctxFor(data: string) {
  const reply = vi.fn(() => Promise.resolve({}));
  const answerCbQuery = vi.fn(() => Promise.resolve(true));
  const editMessageReplyMarkup = vi.fn(() => Promise.resolve(true));
  const ctx = { callbackQuery: { data }, reply, answerCbQuery, editMessageReplyMarkup } as unknown as Context;
  return { ctx, reply, answerCbQuery, editMessageReplyMarkup };
}

describe('buttons operators used to see', () => {
  it.each([
    'agentok:abc123', 'agentno:abc123', 'qg:00000000-0000-0000-0000-000000000001:expense',
    'qg_skip:00000000-0000-0000-0000-000000000001', 'al:alert1:revenue', 'alert_label:a:e:revenue', 'alert_skip:a1',
  ])('%s has expired and changes nothing', async (data) => {
    const { ctx, reply, answerCbQuery, editMessageReplyMarkup } = ctxFor(data);
    await handleCallback(ctx, { userId: 'u1', role: 'operator' } as never);
    expect(answerCbQuery).toHaveBeenCalledWith('This button has expired');
    expect(editMessageReplyMarkup).toHaveBeenCalledWith(undefined);
    expect(reply).toHaveBeenCalledWith(EXPIRED_BUTTON_REPLY);
    expect(query).not.toHaveBeenCalled();
  });
});
