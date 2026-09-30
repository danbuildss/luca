import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({ query: vi.fn(), pool: { connect: vi.fn() } }));

import { handleStart, requireUser, WELCOME_MSG, NOT_INVITED_MSG } from '../../src/telegram/access.js';
import type { AccessResult } from '../../src/telegram/onboarding.js';

// A new beta tester's first /start (Sep 29): Luca sent its welcome, then the /start intro
// straight after. One message now.

const user = { userId: 'u1', telegramId: 42, timezone: 'UTC', role: 'operator' as const };
const ctx = () => ({ from: { id: 42, username: 'austin' }, reply: vi.fn(() => Promise.resolve()), answerCbQuery: vi.fn(() => Promise.resolve()) });
const resolved = (r: AccessResult) => vi.fn(() => Promise.resolve(r));

describe('/start', () => {
  it('someone who just joined gets the welcome, once, and nothing else', async () => {
    const c = ctx();
    await handleStart(c, resolved({ status: 'ok', user, created: true }));
    expect(c.reply).toHaveBeenCalledTimes(1);
    expect(c.reply).toHaveBeenCalledWith(WELCOME_MSG);
  });

  it('someone already in gets the intro, once', async () => {
    const c = ctx();
    await handleStart(c, resolved({ status: 'ok', user, created: false }));
    expect(c.reply).toHaveBeenCalledTimes(1);
    expect(c.reply.mock.calls[0]).toEqual([expect.stringMatching(/^Hi, I'm Luca\./) as string]);
  });

  it('an admin gets the admin commands with it', async () => {
    const c = ctx();
    await handleStart(c, resolved({ status: 'ok', user: { ...user, role: 'admin' }, created: true }));
    expect(c.reply).toHaveBeenCalledTimes(1);
    expect(c.reply).toHaveBeenCalledWith(`${WELCOME_MSG}\n\nAdmin: /ops, /invite @user, /revoke @user, /quality, /goldset`);
  });

  it('someone not invited is told so, once', async () => {
    const c = ctx();
    await handleStart(c, resolved({ status: 'not_invited' }));
    expect(c.reply).toHaveBeenCalledTimes(1);
    expect(c.reply).toHaveBeenCalledWith(NOT_INVITED_MSG);
  });
});

describe('first contact through any other message', () => {
  it('still welcomes someone who just joined (a pasted wallet address, say)', async () => {
    const c = ctx();
    const u = await requireUser(c, { resolve: resolved({ status: 'ok', user, created: true }) });
    expect(u).toMatchObject({ userId: 'u1', justJoined: true });
    expect(c.reply).toHaveBeenCalledWith(WELCOME_MSG);
  });
});
